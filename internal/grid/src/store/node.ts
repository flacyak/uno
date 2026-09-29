// The Node implementation of FileStore, and the handler that opens a file on
// this machine's disks.
//
// Its `write` is internal/safefile/write.go: build a sibling temp file, fsync
// it, and rename over the target, so an interrupted write loses the new content
// rather than the content already there.
//
// Browsing a folder is store/disklister.ts, beside this. The two are the only
// files in the package that import node:fs, which is what the guard test in
// tests/store/opens.test.ts holds them to: reaching a disk is allowed inside the
// seam and nowhere else.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Connection } from "../library/index.ts";
import { covering } from "../library/index.ts";
import type { Provider } from "../plugin/index.ts";
import { diskLister } from "./disklister.ts";
import type { ByteSource, FileHandler, FileStore } from "./index.ts";
import { isRemote, readAll } from "./index.ts";
import type { AwsCredentials, S3Location, Signing } from "./s3.ts";
import { assumeRole, signInAgain, ssoRoleCredentials } from "./sts.ts";
import type { Session } from "./sts.ts";

/**
 * localFiles opens files on this machine's disks, by path, for reading. It
 * claims every path without a scheme in front of it.
 */
export function localFiles(): FileHandler {
  return {
    label: "local files",
    handles: (ref) => "path" in ref && !isRemote(ref.path),
    open: (ref) =>
      "path" in ref
        ? nodeSource(ref.path)
        : Promise.reject(new Error(`${ref.name}: local files are opened by path`)),
  };
}

/**
 * diskProvider is this machine's disks plugged in as one thing: the handler that
 * opens a path and the lister that browses the folder it came out of.
 */
export function diskProvider(): Provider {
  return { name: "disk", label: "local files", files: localFiles(), browse: diskLister() };
}

/**
 * nodeSource reads a file at an offset, so a 30 GB CSV costs a descriptor and
 * not 30 GB.
 *
 * Reads with an explicit position share the descriptor safely, so an index
 * scan and a page read can be in flight together.
 *
 * Only a regular file is a source. A folder opens, has a size that means
 * nothing and fails on the first read without saying where; a fifo does not
 * even open until something writes to it, which holds a thread of the pool
 * for as long as that takes. The open is non-blocking so that a fifo comes
 * back at once, which costs a regular file nothing, and the stat that follows
 * refuses anything that is not a file by its path.
 */
export async function nodeSource(path: string): Promise<ByteSource> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let size: number;
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`${path} is ${st.isDirectory() ? "a folder" : "not a regular file"}`);
    }
    size = st.size;
  } catch (err) {
    await fh.close();
    throw err;
  }

  return {
    size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(want);
      let got = 0;
      // A read may return fewer bytes than asked without being at the end.
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
        if (bytesRead === 0) break; // the file shrank since it was opened
        got += bytesRead;
      }
      return got === want ? buf : buf.subarray(0, got);
    },
    close: () => fh.close(),
  };
}

/**
 * nodeStore is a FileStore backed by the local filesystem.
 *
 * It is created rather than exported as a singleton so a caller can wrap it --
 * a test with a temp directory, a sandbox with a path prefix -- without the
 * core learning that either exists.
 */
export function nodeStore(): FileStore {
  return {
    files: [localFiles()],

    /**
     * write publishes bytes to path atomically.
     *
     * Everything goes to a temp file in the same directory, so the rename that
     * publishes it stays on one filesystem and stays atomic. A failure anywhere
     * -- from the write, from the sync, from the rename -- leaves the previous
     * file untouched and leaves no debris behind.
     */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const dir = dirname(path);
      const scratch = await mkdtemp(join(dir, ".uno-"));
      const tmp = join(scratch, "part");

      try {
        // 0644 because the result is an ordinary user file. The private mode a
        // temp file is created with is a decision about the temp file, not
        // about the document.
        const fh = await open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        try {
          await fh.writeFile(bytes);
          await fh.sync(); // durable before the swap, not after
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(scratch, { recursive: true, force: true }); // a failed write leaves no debris
        throw err;
      }
      await rm(scratch, { recursive: true, force: true });
    },

    /**
     * list names the files directly in dir.
     *
     * A directory that does not exist is empty rather than a failure: a person
     * who has never written a formula has no folder, and that is not a fault
     * worth reporting to them.
     */
    async list(dir: string): Promise<string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => !e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
  };
}

const execFileAsync = promisify(execFile);

/** How long credentials read from disk are reused before they are read again. */
const CREDENTIALS_MS = 60_000;

/** The region a request is signed for when nothing else has said one. */
const DEFAULT_REGION = "us-east-1";

type Env = Record<string, string | undefined>;

/** The two files the AWS CLI reads, as sections of keys. */
interface AwsFiles {
  /** ~/.aws/config, where a named profile's section is `profile <name>`. */
  config: Map<string, Map<string, string>>;
  /** ~/.aws/credentials, where it is `<name>`. */
  credentials: Map<string, Map<string, string>>;
}

/** Where the AWS files are, the way the CLI finds them: the variables, then ~/.aws. */
async function awsFiles(env: Env): Promise<AwsFiles> {
  const aws = join(homeOf(env), ".aws");
  return {
    config: await ini(env["AWS_CONFIG_FILE"] ?? join(aws, "config")),
    credentials: await ini(env["AWS_SHARED_CREDENTIALS_FILE"] ?? join(aws, "credentials")),
  };
}

/** The config section a profile's settings are in: `default`, or `profile <name>`. */
function configOf(files: AwsFiles, profile: string): Map<string, string> | undefined {
  return files.config.get(profile === "default" ? "default" : `profile ${profile}`);
}

/** The region a profile signs for: the environment first, as the CLI has it, then its config. */
function regionOf(env: Env, files: AwsFiles, profile: string): string {
  return (
    env["AWS_REGION"] ??
    env["AWS_DEFAULT_REGION"] ??
    configOf(files, profile)?.get("region") ??
    DEFAULT_REGION
  );
}

/** Credentials, and the moment they stop being reused and are asked for again. */
interface Held {
  creds: AwsCredentials;
  until: number;
}

/**
 * How long before temporary credentials expire they are traded for new ones,
 * so a range read in the last minute of a session is not signed with keys
 * that lapse on the way to S3. Five minutes is what the AWS SDKs allow.
 */
const EARLY_MS = 5 * 60_000;

/** The home folder the AWS files hang off, as the environment says it. */
function homeOf(env: Env): string {
  return env["HOME"] ?? env["USERPROFILE"] ?? homedir();
}

/**
 * profileSession signs in as one named profile, the ways the AWS CLI does, or
 * answers undefined for a profile with no way in at all, which each caller
 * words for itself: the chain found nothing, or the profile a connection named
 * has nothing uno can use.
 *
 * Keys in ~/.aws/credentials, or in the profile's config section, are read as
 * they are and read again a minute later. A credential_process profile runs
 * the program it names and reads the keys it prints. An SSO profile trades
 * the token its last `aws sso login` left behind for a role's keys. Keys that
 * expire are reused until shortly before they do.
 */
async function profileSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  through: readonly string[] = [],
): Promise<Held | undefined> {
  const p = files.credentials.get(profile);
  const fromConfig = configOf(files, profile);
  const region = regionOf(env, files, profile);
  const as = `the AWS profile ${profile}`;

  // A role comes first, as it does for the CLI: a profile with role_arn is the
  // role, whatever else it holds, and its keys are whatever its source's are.
  const roleArn = fromConfig?.get("role_arn") ?? p?.get("role_arn");
  if (roleArn !== undefined) {
    const setting = (key: string): string | undefined => fromConfig?.get(key) ?? p?.get(key);
    const { expiration, ...keys } = await roleSession(
      env,
      files,
      profile,
      roleArn,
      setting,
      through,
    );
    return { creds: { ...keys, region, as }, until: expiration.getTime() - EARLY_MS };
  }

  const own = profileKeysOnly(env, files, profile);
  if (own !== undefined) return { creds: { ...own.creds, as }, until: own.until };
  const command = fromConfig?.get("credential_process");
  if (command !== undefined) {
    const { expiration, ...keys } = await processCredentials(profile, command);
    return {
      creds: { ...keys, region, as },
      until: expiration === undefined ? Infinity : expiration.getTime() - EARLY_MS,
    };
  }
  if (fromConfig?.has("sso_session") === true || fromConfig?.has("sso_start_url") === true) {
    const { expiration, ...keys } = await ssoSession(env, files, profile, fromConfig);
    return { creds: { ...keys, region, as }, until: expiration.getTime() - EARLY_MS };
  }
  return undefined;
}

/**
 * ssoSession reads the token `aws sso login` cached for a profile and trades
 * it at the SSO portal for the profile's role.
 *
 * Two layouts name the portal. The current one puts it in an `[sso-session
 * <name>]` section the profile names with sso_session, and caches the token
 * under the SHA-1 of that name. The older one puts sso_start_url and
 * sso_region in the profile itself and caches under the SHA-1 of the URL.
 *
 * uno never signs in for anybody. An expired or missing token is said, with
 * the command that mends it, before the portal is asked anything.
 */
async function ssoSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  section: Map<string, string>,
): Promise<Session> {
  const named = section.get("sso_session");
  const portal = named === undefined ? section : files.config.get(`sso-session ${named}`);
  if (portal === undefined) {
    throw new Error(
      `the AWS profile ${profile} names sso-session ${named}, which ~/.aws/config does not have`,
    );
  }
  const startUrl = portal.get("sso_start_url");
  const ssoRegion = portal.get("sso_region");
  const accountId = section.get("sso_account_id");
  const roleName = section.get("sso_role_name");
  const missing = [
    ["sso_start_url", startUrl],
    ["sso_region", ssoRegion],
    ["sso_account_id", accountId],
    ["sso_role_name", roleName],
  ].find(([, v]) => v === undefined)?.[0];
  if (missing !== undefined) {
    throw new Error(`the AWS profile ${profile} signs in through SSO and has no ${missing}`);
  }

  const cacheKey = named ?? startUrl!;
  const name = createHash("sha1").update(cacheKey).digest("hex") + ".json";
  const path = join(homeOf(env), ".aws", "sso", "cache", name);
  let text: string;
  try {
    text = new TextDecoder().decode(await readAll([localFiles()], { name, path }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(signInAgain(profile, "uno found no SSO sign-in for it"));
  }
  // `aws sso login` writes the cache in place, so a sign-in cut short leaves
  // half a file: a sign-in uno cannot read, mended the same way as any other.
  const token = cachedToken(text);
  // Older CLIs wrote the time with a UTC suffix rather than a Z.
  const expires = new Date(String(token?.expiresAt).replace(/UTC$/, "Z"));
  if (typeof token?.accessToken !== "string" || Number.isNaN(expires.getTime())) {
    throw new Error(signInAgain(profile, "its cached SSO sign-in could not be read"));
  }
  if (expires.getTime() <= Date.now()) {
    throw new Error(signInAgain(profile, `its SSO sign-in expired at ${expires.toISOString()}`));
  }

  return ssoRoleCredentials(
    {
      profile,
      region: ssoRegion!,
      accountId: accountId!,
      roleName: roleName!,
      accessToken: token.accessToken,
    },
    { endpoint: env["AWS_ENDPOINT_URL_SSO"] },
  );
}

/** What a cache file holds, where it holds a JSON object at all. */
function cachedToken(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * roleSession takes on the role a profile names, with the credentials of the
 * profile it names as source_profile -- which may be keys, a program, an SSO
 * sign-in, or another role, followed as far as the chain goes.
 *
 * A chain that comes back to a profile already on it would ask STS forever,
 * and is refused naming the whole loop. mfa_serial is refused by name: it
 * asks for a code from a device, and the engine has nobody to ask.
 */
async function roleSession(
  env: Env,
  files: AwsFiles,
  profile: string,
  roleArn: string,
  setting: (key: string) => string | undefined,
  through: readonly string[],
): Promise<Session> {
  const chain = [...through, profile];
  if (setting("mfa_serial") !== undefined) {
    throw new Error(
      `the AWS profile ${profile} asks for an MFA code to assume ${roleArn}, which uno cannot ask for · ` +
        `run \`aws configure export-credentials --profile ${profile} --format env\` and start uno from that shell`,
    );
  }

  let source: AwsCredentials;
  const sourceProfile = setting("source_profile");
  const credentialSource = setting("credential_source");
  if (sourceProfile !== undefined) {
    if (chain.includes(sourceProfile)) {
      throw new Error(
        `the AWS profile ${profile} takes its credentials from a loop · ${[...chain, sourceProfile].join(" → ")}`,
      );
    }
    // A profile that is its own source means the keys beside its role_arn,
    // which is how the CLI reads it too.
    const held =
      sourceProfile === profile
        ? profileKeysOnly(env, files, profile)
        : await profileSession(env, files, sourceProfile, chain);
    if (held === undefined) {
      throw new Error(
        `the AWS profile ${profile} takes its credentials from ${sourceProfile}, which has no way in uno can use`,
      );
    }
    source = held.creds;
  } else if (credentialSource === "Environment") {
    const id = env["AWS_ACCESS_KEY_ID"];
    const secret = env["AWS_SECRET_ACCESS_KEY"];
    if (id === undefined || id === "" || secret === undefined || secret === "") {
      throw new Error(
        `the AWS profile ${profile} takes its credentials from the environment, which has no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY`,
      );
    }
    source = {
      accessKeyId: id,
      secretAccessKey: secret,
      sessionToken: env["AWS_SESSION_TOKEN"],
      region: DEFAULT_REGION,
    };
  } else if (credentialSource !== undefined) {
    throw new Error(
      `the AWS profile ${profile} takes its credentials from ${credentialSource}, which uno does not reach · use source_profile or Environment`,
    );
  } else {
    throw new Error(
      `the AWS profile ${profile} names a role_arn and no source_profile to assume it with`,
    );
  }

  const duration = setting("duration_seconds");
  return assumeRole(
    {
      roleArn,
      sessionName: setting("role_session_name") ?? `uno-${Date.now()}`,
      externalId: setting("external_id"),
      durationSeconds: duration === undefined ? undefined : Number(duration),
      region: regionOf(env, files, profile),
    },
    source,
    { endpoint: env["AWS_ENDPOINT_URL_STS"] },
  );
}

/** A profile's own static keys, for a role profile that is its own source. */
function profileKeysOnly(env: Env, files: AwsFiles, profile: string): Held | undefined {
  const p = files.credentials.get(profile);
  const fromConfig = configOf(files, profile);
  const key = p?.get("aws_access_key_id") ?? fromConfig?.get("aws_access_key_id");
  const secret = p?.get("aws_secret_access_key") ?? fromConfig?.get("aws_secret_access_key");
  if (key === undefined || secret === undefined) return undefined;
  const token = p?.get("aws_session_token") ?? fromConfig?.get("aws_session_token");
  return {
    creds: {
      accessKeyId: key,
      secretAccessKey: secret,
      sessionToken: token,
      region: regionOf(env, files, profile),
    },
    until: Date.now() + CREDENTIALS_MS,
  };
}

/**
 * How long a credential_process program is given to answer. A program that
 * asks a vault or a hardware key can take a few seconds; one that has not
 * answered in thirty is waiting on something that is not coming, and a range
 * read waiting behind it would look like uno had hung.
 */
const PROCESS_MS = 30_000;

/** The most a credential_process program may print. Its answer is a few hundred bytes. */
const PROCESS_BYTES = 1 << 20;

/** Keys a program printed, and when they stop working, where it said. */
interface Printed {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * processCredentials runs a profile's credential_process and reads the keys it
 * prints, which is how the AWS CLI hands signing in to another program: a
 * vault, a hardware key, a company's own tool.
 *
 * The command is split into words the way a shell would split it, quotes and
 * all, and run without a shell, so nothing in ~/.aws/config is ever handed to
 * one to interpret. What it prints is the CLI's version 1 answer, and anything
 * else is refused by name rather than guessed at.
 */
async function processCredentials(profile: string, command: string): Promise<Printed> {
  const words = splitCommand(command);
  const [program, ...args] = words;
  if (program === undefined) {
    throw new Error(`the AWS profile ${profile} has an empty credential_process`);
  }

  let out: string;
  try {
    const run = await execFileAsync(program, args, {
      timeout: PROCESS_MS,
      maxBuffer: PROCESS_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
    out = run.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const why =
      e.code === "ENOENT"
        ? `there is no program called ${program}`
        : e.killed === true
          ? `it did not answer within ${PROCESS_MS / 1000} seconds`
          : (e.stderr?.trim().split("\n")[0] ?? "") || e.message;
    throw new Error(`the AWS profile ${profile}'s credential_process failed · ${why}`);
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(out) as Record<string, unknown>;
  } catch {
    throw new Error(`the AWS profile ${profile}'s credential_process did not print JSON`);
  }
  if (o["Version"] !== 1) {
    throw new Error(
      `the AWS profile ${profile}'s credential_process printed version ${JSON.stringify(o["Version"])} · uno reads version 1`,
    );
  }
  const id = o["AccessKeyId"];
  const secret = o["SecretAccessKey"];
  if (typeof id !== "string" || typeof secret !== "string") {
    throw new Error(
      `the AWS profile ${profile}'s credential_process printed no AccessKeyId and SecretAccessKey`,
    );
  }
  const printed: Printed = { accessKeyId: id, secretAccessKey: secret };
  if (typeof o["SessionToken"] === "string") printed.sessionToken = o["SessionToken"];
  if (typeof o["Expiration"] === "string") {
    const at = new Date(o["Expiration"]);
    if (Number.isNaN(at.getTime())) {
      throw new Error(
        `the AWS profile ${profile}'s credential_process printed an Expiration uno cannot read`,
      );
    }
    printed.expiration = at;
  }
  return printed;
}

/**
 * splitCommand splits a command line into words the way a POSIX shell would,
 * and does nothing else a shell does: single quotes keep everything, double
 * quotes keep everything but a backslash before a quote or a backslash, and a
 * backslash outside quotes keeps the next character. There is no expansion,
 * no globbing, and no second command after a semicolon, which stays a word.
 */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let open = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`credential_process has a ' with no ' to close it`);
      word += line.slice(i + 1, end);
      i = end;
      open = true;
    } else if (c === '"') {
      open = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) i++;
        word += line[i];
      }
      if (i >= line.length) throw new Error(`credential_process has a " with no " to close it`);
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      open = true;
    } else if (/\s/.test(c)) {
      if (open) words.push(word);
      word = "";
      open = false;
    } else {
      word += c;
      open = true;
    }
  }
  if (open) words.push(word);
  return words;
}

/**
 * cached reuses what `read` answered until it says to stop: a minute for keys
 * read off the disk, so a key rotated there is picked up within it, and until
 * shortly before expiry for keys AWS handed out, so a request per range does
 * not trade a token per range.
 *
 * Asks that land while one read is on its way share it. Forty sources opening
 * at once ask forty times before the first answer is back, and each ask that
 * read on its own would be a program run, a portal call or an AssumeRole of
 * its own: a credential_process that asks a vault for its answer would ask
 * forty times. A read that fails answers everybody waiting on it with the
 * failure, and is not kept, so the next ask reads again.
 */
function cached(read: () => Promise<Held>): () => Promise<AwsCredentials> {
  let kept: Held | undefined;
  let reading: Promise<Held> | undefined;
  return async () => {
    if (kept !== undefined && Date.now() < kept.until) return kept.creds;
    reading ??= read().then(
      (held) => {
        kept = held;
        reading = undefined;
        return held;
      },
      (err: unknown) => {
        reading = undefined;
        throw err;
      },
    );
    return (await reading).creds;
  };
}

/**
 * awsCredentials finds AWS credentials the way the AWS CLI does: the
 * environment first, then the profile AWS_PROFILE names, or `default`, signed
 * in to whichever way that profile says.
 *
 * This is the `machine` way of signing in, and what a request covered by no
 * connection signs with. uno stores nothing. What it can read is what the
 * person already set up for every other tool, and it is read in the engine's
 * process, so a key never reaches the page that draws the grid.
 */
export function awsCredentials(env: Env = process.env): () => Promise<AwsCredentials> {
  return cached(async () => {
    const profile = env["AWS_PROFILE"] ?? env["AWS_DEFAULT_PROFILE"] ?? "default";
    const files = await awsFiles(env);
    const id = env["AWS_ACCESS_KEY_ID"];
    const secret = env["AWS_SECRET_ACCESS_KEY"];
    if (id !== undefined && id !== "" && secret !== undefined && secret !== "") {
      return {
        creds: {
          accessKeyId: id,
          secretAccessKey: secret,
          sessionToken: env["AWS_SESSION_TOKEN"],
          region: regionOf(env, files, profile),
        },
        until: Date.now() + CREDENTIALS_MS,
      };
    }
    const held = await profileSession(env, files, profile);
    if (held !== undefined) return held;
    throw new Error(
      `no AWS credentials · set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or put keys for the ${profile} profile in ~/.aws/credentials`,
    );
  });
}

/**
 * profileCredentials signs in as one named profile, whatever AWS_PROFILE says
 * and whatever keys are in the environment: a connection that names a profile
 * means that one.
 */
export function profileCredentials(
  profile: string,
  env: Env = process.env,
): () => Promise<AwsCredentials> {
  return cached(async () => {
    const files = await awsFiles(env);
    const held = await profileSession(env, files, profile);
    if (held !== undefined) return held;
    if (!files.credentials.has(profile) && configOf(files, profile) === undefined) {
      throw new Error(
        `there is no AWS profile called ${profile} in ~/.aws/config or ~/.aws/credentials`,
      );
    }
    throw new Error(
      `the AWS profile ${profile} has no way in uno can use · give it keys in ~/.aws/credentials, a credential_process, or an SSO sign-in`,
    );
  });
}

/**
 * awsProfiles names the profiles this machine has, for a person choosing which
 * one a connection signs in as, and answers nothing else out of the files.
 *
 * A profile is a `[profile <name>]` or `[default]` section of ~/.aws/config, or
 * any section of ~/.aws/credentials. The other sections of config --
 * sso-session, services -- are not profiles and are not named. `default`
 * comes first, since it is the one a person means when they did not say, and
 * the rest in name order.
 */
export async function awsProfiles(env: Env = process.env): Promise<string[]> {
  const files = await awsFiles(env);
  const names = new Set<string>();
  for (const section of files.config.keys()) {
    if (section === "default") names.add(section);
    else if (section.startsWith("profile ")) names.add(section.slice("profile ".length).trim());
  }
  for (const section of files.credentials.keys()) names.add(section);
  return [...names].toSorted((a, b) =>
    a === "default" ? -1 : b === "default" ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
}

/**
 * ConnectionAuth signs in the way a connection says to, keeping one set of
 * credentials per way so two connections on one profile read it once.
 */
export interface ConnectionAuth {
  /** The machine's chain: what a request no connection covers signs with. */
  machine(): Promise<AwsCredentials>;
  /** How a request through `c` goes out. Refuses a way this platform does not sign in. */
  of(c: Connection): Promise<Signing>;
}

/**
 * connectionAuth is the desktop's ways of signing in: `machine`, `profile` and
 * `public`. `role` is the hosted engine's, taken on with the requesting
 * account's external ID, and is refused here by name rather than tried with
 * whatever this machine has.
 */
export function connectionAuth(env: Env = process.env): ConnectionAuth {
  const machine = awsCredentials(env);
  const profiles = new Map<string, () => Promise<AwsCredentials>>();
  const who = (c: Connection): string => (c.name === "" ? c.id : c.name);

  return {
    machine,
    async of(c) {
      switch (c.auth.mode) {
        case "machine": {
          const creds = await machine();
          return {
            ...creds,
            region: c.region ?? creds.region,
            as: `${who(c)} (this machine's AWS credentials)`,
          };
        }
        case "profile": {
          const name = c.auth.profile;
          let read = profiles.get(name);
          if (read === undefined) {
            read = profileCredentials(name, env);
            profiles.set(name, read);
          }
          const creds = await read();
          return {
            ...creds,
            region: c.region ?? creds.region,
            as: `${who(c)} (the AWS profile ${name})`,
          };
        }
        case "public":
          return {
            unsigned: true,
            region: c.region ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? DEFAULT_REGION,
            as: `${who(c)} (read without signing in)`,
          };
        case "role":
          throw new Error(
            `${who(c)} signs in with a role, which only uno's hosted engine takes on · ` +
              `on the desktop, connect it with a profile that can assume ${c.auth.roleArn}`,
          );
      }
    },
  };
}

/**
 * connectionSigning is how the desktop's S3 provider signs each request: with
 * the connection that covers where it is going, and with the machine's chain
 * where none does -- an address somebody pasted, a bucket nobody connected.
 *
 * `connections` is asked on every request rather than handed over once, so a
 * connection saved while the engine runs is the one its next request uses.
 */
export function connectionSigning(
  connections: () => readonly Connection[],
  env: Env = process.env,
  auth: ConnectionAuth = connectionAuth(env),
): (loc: S3Location) => Promise<Signing> {
  return (loc) => {
    const c = covering(connections(), loc.bucket, loc.key);
    return c === undefined ? auth.machine() : auth.of(c);
  };
}

/** ini reads an AWS-style ini file into sections of keys. A missing file is empty. */
async function ini(path: string): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  let text: string;
  try {
    const ref = { name: basename(path), path };
    text = new TextDecoder().decode(await readAll([localFiles()], ref));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  let section: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head !== null) {
      section = new Map();
      out.set(head[1]!.trim(), section);
      continue;
    }
    const eq = line.indexOf("=");
    if (section === undefined || eq < 0) continue;
    section.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}
