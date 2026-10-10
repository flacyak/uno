// The Node FileStore, the handler that opens a file on this machine's disks,
// and the AWS credential chain read from ~/.aws.
//
// `write` builds a sibling temp file, fsyncs it and renames it over the
// target. Only this file and store/disklister.ts import node:fs. The guard
// test in tests/store/opens.test.ts checks that.

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
 * localFiles opens files on this machine's disks by path, for reading. It
 * claims every scheme-free path.
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

/** diskProvider is this machine's disks: localFiles and diskLister. */
export function diskProvider(): Provider {
  return { name: "disk", label: "local files", files: localFiles(), browse: diskLister() };
}

/**
 * nodeSource opens a file and reads it at an offset through one descriptor.
 * Positional reads share the descriptor, so reads can be in flight together.
 *
 * Only a regular file opens. The open is non-blocking so a fifo returns at
 * once, and the stat after it refuses everything but a regular file.
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
      // A read may return fewer bytes than asked while more remain.
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

/** nodeStore is a FileStore backed by the local filesystem. */
export function nodeStore(): FileStore {
  return {
    files: [localFiles()],

    /**
     * write replaces the file at path atomically: the bytes go to a temp file
     * in the same directory, which is fsynced and renamed over the target. A
     * failure leaves the previous file untouched and removes the temp
     * directory.
     */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      const dir = dirname(path);
      const scratch = await mkdtemp(join(dir, ".uno-"));
      const tmp = join(scratch, "part");

      try {
        // 0644: the result is an ordinary user file.
        const fh = await open(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644,
        );
        try {
          await fh.writeFile(bytes);
          await fh.sync(); // durable before the swap
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      } catch (err) {
        await rm(scratch, { recursive: true, force: true }); // a failed write cleans up after itself
        throw err;
      }
      await rm(scratch, { recursive: true, force: true });
    },

    /**
     * list names the files directly in dir. A missing directory is an empty
     * list.
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

/** The fallback region a request is signed for. */
const DEFAULT_REGION = "us-east-1";

type Env = Record<string, string | undefined>;

/** The two files the AWS CLI reads, as sections of keys. */
interface AwsFiles {
  /** ~/.aws/config, where a named profile's section is `profile <name>`. */
  config: Map<string, Map<string, string>>;
  /** ~/.aws/credentials, where it is `<name>`. */
  credentials: Map<string, Map<string, string>>;
}

/** Reads the AWS files from the paths the environment names, or ~/.aws. */
async function awsFiles(env: Env): Promise<AwsFiles> {
  const aws = join(homeOf(env), ".aws");
  return {
    config: await ini(env["AWS_CONFIG_FILE"] ?? join(aws, "config")),
    credentials: await ini(env["AWS_SHARED_CREDENTIALS_FILE"] ?? join(aws, "credentials")),
  };
}

/** The config section a profile's settings are in: `default`, or
 * `profile <name>`. */
function configOf(files: AwsFiles, profile: string): Map<string, string> | undefined {
  return files.config.get(profile === "default" ? "default" : `profile ${profile}`);
}

/** The region a profile signs for: the environment, then its config, then
 * the default. */
function regionOf(env: Env, files: AwsFiles, profile: string): string {
  return envRegion(env) ?? configOf(files, profile)?.get("region") ?? DEFAULT_REGION;
}

/** The region the environment names, or undefined. */
function envRegion(env: Env): string | undefined {
  return env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"];
}

/**
 * envKeys is the keys in the environment, signing for `region`, or undefined
 * where there are none. An empty variable counts as none.
 */
function envKeys(env: Env, region: string): AwsCredentials | undefined {
  const id = env["AWS_ACCESS_KEY_ID"];
  const secret = env["AWS_SECRET_ACCESS_KEY"];
  if (id === undefined || id === "" || secret === undefined || secret === "") return undefined;
  const sessionToken = env["AWS_SESSION_TOKEN"];
  return { accessKeyId: id, secretAccessKey: secret, sessionToken, region };
}

/** Credentials, and the time after which they are read again. */
interface Held {
  creds: AwsCredentials;
  until: number;
}

/**
 * How long before temporary credentials expire they are replaced, so a request
 * is signed with keys that outlast it. Five minutes, as the AWS SDKs use.
 */
const EARLY_MS = 5 * 60_000;

/** The home folder the AWS files are under. */
function homeOf(env: Env): string {
  return env["HOME"] ?? env["USERPROFILE"] ?? homedir();
}

/**
 * profileSession signs in as one named profile the way the AWS CLI does,
 * when the profile offers one of the ways below, and returns undefined
 * otherwise.
 *
 * In order: a role_arn is assumed through its source. Static keys in
 * ~/.aws/credentials or the config section are used as they are and read
 * again after a minute. A credential_process is run and its output read. An
 * SSO profile trades its cached token for keys. Expiring keys are reused
 * until shortly before they expire.
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

  // A profile with role_arn is the role, whatever else it holds, as for the
  // CLI.
  const roleArn = fromConfig?.get("role_arn") ?? p?.get("role_arn");
  if (roleArn !== undefined) {
    const setting = (key: string): string | undefined => fromConfig?.get(key) ?? p?.get(key);
    return hold(await roleSession(env, files, profile, roleArn, setting, through));
  }

  const own = profileKeysOnly(env, files, profile);
  if (own !== undefined) return { creds: { ...own.creds, as }, until: own.until };
  const command = fromConfig?.get("credential_process");
  if (command !== undefined) return hold(await processCredentials(profile, command));
  if (fromConfig?.has("sso_session") === true || fromConfig?.has("sso_start_url") === true) {
    return hold(await ssoSession(env, files, profile, fromConfig));
  }
  return undefined;

  /** hold is a session as this profile's credentials, kept until shortly
   * before it expires, or for good for keys that last. */
  function hold({ expiration, ...keys }: Printed | Session): Held {
    const until = expiration === undefined ? Infinity : expiration.getTime() - EARLY_MS;
    return { creds: { ...keys, region, as }, until };
  }
}

/**
 * ssoSession reads the token `aws sso login` cached for a profile and trades
 * it at the SSO portal for the profile's role.
 *
 * The portal is named in one of two layouts: an `[sso-session <name>]`
 * section the profile names with sso_session, cached under the SHA-1 of that
 * name, or sso_start_url and sso_region in the profile itself, cached under
 * the SHA-1 of the URL. A missing or expired token is refused with the
 * command that fixes it, before the portal is asked.
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
  const text = await readText(path, name);
  if (text === undefined) throw new Error(signInAgain(profile, "uno found no SSO sign-in for it"));
  // A cache file that fails to parse is refused like a missing sign-in.
  const token = cachedToken(text);
  // Older CLIs wrote the time with a UTC suffix, where newer write Z.
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

/** The JSON object a cache file holds, or undefined. */
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
 * roleSession assumes the role a profile names with the credentials of its
 * source_profile, which may be any kind of profile, including another role.
 * A chain that comes back to a profile already on it is refused naming the
 * loop. mfa_serial is refused, since a code needs a prompt the engine lacks.
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
    // A profile that is its own source means the static keys beside its
    // role_arn.
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
    const held = envKeys(env, DEFAULT_REGION);
    if (held === undefined) {
      throw new Error(
        `the AWS profile ${profile} takes its credentials from the environment, which has no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY`,
      );
    }
    source = held;
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

/** How long a credential_process program is given to answer. */
const PROCESS_MS = 30_000;

/** The most a credential_process program may print. */
const PROCESS_BYTES = 1 << 20;

/** Keys a credential_process printed, and when they expire where it said. */
interface Printed {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * processCredentials runs a profile's credential_process and reads the keys
 * it prints. The command is split into words the way a shell would and run
 * directly, as a program and its arguments. The output must be the CLI's
 * version 1 JSON.
 */
async function processCredentials(profile: string, command: string): Promise<Printed> {
  /** fail is an Error about this profile's credential_process. */
  const fail = (why: string): Error =>
    new Error(`the AWS profile ${profile}'s credential_process ${why}`);
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
    throw fail(`failed · ${why}`);
  }

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(out) as Record<string, unknown>;
  } catch {
    throw fail("did not print JSON");
  }
  if (o["Version"] !== 1) {
    throw fail(`printed version ${JSON.stringify(o["Version"])} · uno reads version 1`);
  }
  const id = o["AccessKeyId"];
  const secret = o["SecretAccessKey"];
  if (typeof id !== "string" || typeof secret !== "string") {
    throw fail("printed no AccessKeyId and SecretAccessKey");
  }
  const printed: Printed = { accessKeyId: id, secretAccessKey: secret };
  if (typeof o["SessionToken"] === "string") printed.sessionToken = o["SessionToken"];
  if (typeof o["Expiration"] === "string") {
    const at = new Date(o["Expiration"]);
    if (Number.isNaN(at.getTime())) {
      throw fail("printed an Expiration uno cannot read");
    }
    printed.expiration = at;
  }
  return printed;
}

/**
 * splitCommand splits a command line into words the way a POSIX shell would,
 * and that is all of the shell it has: single quotes keep everything, double
 * quotes keep everything but a backslash before a quote or a backslash, and
 * a backslash outside quotes keeps the next character. Every other character
 * is plain text: a `$`, a `*` and a semicolon are each part of a word.
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
 * cached reuses what `read` returned until its `until` time passes. Calls
 * that land while a read is in flight share it. A read that fails rejects
 * every waiting call and is dropped, so the next call reads again.
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
 * awsCredentials finds credentials the way the AWS CLI does: the environment
 * first, then the profile AWS_PROFILE or AWS_DEFAULT_PROFILE names, or
 * `default`. This is the `machine` way of signing in, and what a request
 * outside every connection signs with.
 */
export function awsCredentials(env: Env = process.env): () => Promise<AwsCredentials> {
  return cached(async () => {
    const profile = env["AWS_PROFILE"] ?? env["AWS_DEFAULT_PROFILE"] ?? "default";
    const files = await awsFiles(env);
    const fromEnv = envKeys(env, regionOf(env, files, profile));
    if (fromEnv !== undefined) return { creds: fromEnv, until: Date.now() + CREDENTIALS_MS };
    const held = await profileSession(env, files, profile);
    if (held !== undefined) return held;
    throw new Error(
      `no AWS credentials · set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or put keys for the ${profile} profile in ~/.aws/credentials`,
    );
  });
}

/**
 * profileCredentials signs in as one named profile, ignoring AWS_PROFILE and
 * any keys in the environment.
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
 * awsProfiles names the profiles on this machine: every `[profile <name>]`
 * or `[default]` section of ~/.aws/config and every section of
 * ~/.aws/credentials. `default` comes first, then the rest in name order.
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
 * credentials per way.
 */
export interface ConnectionAuth {
  /** The machine's chain: what a request outside every connection signs
   * with. */
  machine(): Promise<AwsCredentials>;
  /** How a request through `c` is signed. Refuses a mode this platform
   * lacks. */
  of(c: Connection): Promise<Signing>;
}

/**
 * connectionAuth is the desktop's ways of signing in: `machine`, `profile`
 * and `public`. `role` is refused. It is the hosted engine's.
 */
export function connectionAuth(env: Env = process.env): ConnectionAuth {
  const machine = awsCredentials(env);
  const profiles = new Map<string, () => Promise<AwsCredentials>>();
  const who = (c: Connection): string => (c.name === "" ? c.id : c.name);
  /** signed is `creds` in c's region where it names one, labelled with whose
   * they are. */
  const signed = (c: Connection, creds: AwsCredentials, through: string): Signing => ({
    ...creds,
    region: c.region ?? creds.region,
    as: `${who(c)} (${through})`,
  });

  return {
    machine,
    async of(c) {
      switch (c.auth.mode) {
        case "machine":
          return signed(c, await machine(), "this machine's AWS credentials");
        case "profile": {
          const name = c.auth.profile;
          let read = profiles.get(name);
          if (read === undefined) {
            read = profileCredentials(name, env);
            profiles.set(name, read);
          }
          return signed(c, await read(), `the AWS profile ${name}`);
        }
        case "public":
          return {
            unsigned: true,
            region: c.region ?? envRegion(env) ?? DEFAULT_REGION,
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
 * What a hosted engine signs in with. `base` is the engine's own credentials,
 * which the customer's role trusts. `externalId` is the condition the
 * customer's trust policy checks. It comes from the requesting account and
 * stays out of connection files. `principal` is what the engine signs as, for
 * writing that policy.
 */
export interface HostedOptions {
  base: () => Promise<AwsCredentials>;
  externalId: string;
  principal: string;
  env?: Env;
  /** Where STS is, for a test stand-in. Otherwise AWS_ENDPOINT_URL_STS. */
  stsEndpoint?: string;
}

/**
 * hostedAuth is the hosted engine's ways of signing in: `role` and `public`.
 * A `role` connection is assumed through STS with the account's external ID,
 * and its keys are kept until shortly before they expire. `machine` and
 * `profile` are refused, and `machine()` rejects, so only an address a
 * connection covers is read.
 */
export function hostedAuth(opts: HostedOptions): ConnectionAuth {
  const env = opts.env ?? process.env;
  const roles = new Map<string, () => Promise<AwsCredentials>>();
  const who = (c: Connection): string => (c.name === "" ? c.id : c.name);
  return {
    machine() {
      return Promise.reject(
        new Error(
          "uno's hosted engine reads only the buckets a connection covers · " +
            "it signs in with a role in your account, not with a machine of its own",
        ),
      );
    },
    async of(c) {
      switch (c.auth.mode) {
        case "role": {
          const roleArn = c.auth.roleArn;
          let read = roles.get(roleArn);
          if (read === undefined) {
            read = cached(async () => {
              const source = await opts.base();
              const session = await assumeRole(
                {
                  roleArn,
                  sessionName: `uno-${Date.now()}`,
                  externalId: opts.externalId,
                  region: c.region ?? source.region,
                },
                source,
                { endpoint: opts.stsEndpoint ?? env["AWS_ENDPOINT_URL_STS"] },
              );
              return {
                creds: { ...session, region: c.region ?? source.region },
                until: session.expiration.getTime() - EARLY_MS,
              };
            });
            roles.set(roleArn, read);
          }
          const creds = await read();
          return {
            ...creds,
            region: c.region ?? creds.region,
            as: `${who(c)} (a role in your account)`,
          };
        }
        case "public":
          return {
            unsigned: true,
            region: c.region ?? envRegion(env) ?? DEFAULT_REGION,
            as: `${who(c)} (read without signing in)`,
          };
        case "machine":
        case "profile":
          throw new Error(
            `${who(c)} signs in as a machine of its own, which uno's hosted engine is not · ` +
              "connect it with a role in your account that uno may assume",
          );
      }
    },
  };
}

/**
 * connectionSigning signs each request with the connection that covers its
 * location, or with the machine's chain where none does. `connections` is
 * called on every request, so a connection saved while the engine runs is
 * used by the next request.
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

/** readText is a file's text, or undefined for a missing file. */
async function readText(path: string, name = basename(path)): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await readAll([localFiles()], { name, path }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** ini reads an AWS-style ini file into sections of keys. A missing file is
 * empty. */
async function ini(path: string): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const text = await readText(path);
  if (text === undefined) return out;
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
