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

import { constants } from "node:fs";
import { mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Connection } from "../library/index.ts";
import { covering } from "../library/index.ts";
import type { Provider } from "../plugin/index.ts";
import { diskLister } from "./disklister.ts";
import type { ByteSource, FileHandler, FileStore } from "./index.ts";
import { isRemote, readAll } from "./index.ts";
import type { AwsCredentials, S3Location, Signing } from "./s3.ts";

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
 */
export async function nodeSource(path: string): Promise<ByteSource> {
  const fh = await open(path, "r");
  let size: number;
  try {
    size = (await fh.stat()).size;
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
  const aws = join(env["HOME"] ?? env["USERPROFILE"] ?? homedir(), ".aws");
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

/**
 * profileKeys reads one named profile's credentials out of the AWS files, or
 * answers undefined for a profile with none, which each caller words for
 * itself: the chain found nothing, or the profile a connection named has none.
 *
 * Keys in ~/.aws/credentials, or in the profile's config section, are read as
 * they are. A profile that signs in some other way -- SSO, a program to run --
 * is refused by name with the command that turns it into keys this can read.
 */
function profileKeys(env: Env, files: AwsFiles, profile: string): AwsCredentials | undefined {
  const p = files.credentials.get(profile);
  const fromConfig = configOf(files, profile);
  const key = p?.get("aws_access_key_id") ?? fromConfig?.get("aws_access_key_id");
  const secret = p?.get("aws_secret_access_key") ?? fromConfig?.get("aws_secret_access_key");
  if (key !== undefined && secret !== undefined) {
    const token = p?.get("aws_session_token") ?? fromConfig?.get("aws_session_token");
    const region = regionOf(env, files, profile);
    const as = `the AWS profile ${profile}`;
    return { accessKeyId: key, secretAccessKey: secret, sessionToken: token, region, as };
  }
  if (fromConfig?.has("sso_session") === true || fromConfig?.has("sso_start_url") === true) {
    throw new Error(
      `the AWS profile ${profile} signs in through SSO, which uno does not follow yet · ` +
        `run \`aws configure export-credentials --profile ${profile} --format env\` and start uno from that shell`,
    );
  }
  return undefined;
}

/**
 * cached reuses what `read` answered for CREDENTIALS_MS, so a request per
 * range does not read ~/.aws per range, and a key rotated on disk is picked
 * up within the minute.
 */
function cached(read: () => Promise<AwsCredentials>): () => Promise<AwsCredentials> {
  let kept: { at: number; creds: AwsCredentials } | undefined;
  return async () => {
    if (kept !== undefined && Date.now() - kept.at < CREDENTIALS_MS) return kept.creds;
    const creds = await read();
    kept = { at: Date.now(), creds };
    return creds;
  };
}

/**
 * awsCredentials finds AWS credentials the way the AWS CLI does, as far as a
 * person with keys is concerned: the environment first, then the profile in
 * ~/.aws/credentials that AWS_PROFILE names, or `default`.
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
        accessKeyId: id,
        secretAccessKey: secret,
        sessionToken: env["AWS_SESSION_TOKEN"],
        region: regionOf(env, files, profile),
      };
    }
    const creds = profileKeys(env, files, profile);
    if (creds !== undefined) return creds;
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
    const creds = profileKeys(env, files, profile);
    if (creds !== undefined) return creds;
    if (!files.credentials.has(profile) && configOf(files, profile) === undefined) {
      throw new Error(
        `there is no AWS profile called ${profile} in ~/.aws/config or ~/.aws/credentials`,
      );
    }
    throw new Error(
      `the AWS profile ${profile} has no keys uno can read · put aws_access_key_id and aws_secret_access_key for it in ~/.aws/credentials`,
    );
  });
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
