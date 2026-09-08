// The Node implementation of FileStore, and the only file in the package that
// imports node:fs.
//
// Its `write` is internal/safefile/write.go: build a sibling temp file, fsync
// it, and rename over the target, so an interrupted write loses the new content
// rather than the content already there.

import { constants } from "node:fs";
import { mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Provider } from "../plugin/index.ts";
import type { ByteSource, FileHandler, FileStore } from "./index.ts";
import { isRemote, readAll } from "./index.ts";
import type { AwsCredentials } from "./s3.ts";

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
 * diskProvider is this machine's disks plugged in as one thing.
 *
 * Its lister is task 1.2 and is not here yet, which is why `browse` is absent:
 * a provider that cannot browse says so by having nothing, and the panel that
 * asks gets the refusal by name rather than an empty folder.
 */
export function diskProvider(): Provider {
  return { name: "disk", label: "local files", files: localFiles() };
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

/**
 * awsCredentials finds AWS credentials the way the AWS CLI does, as far as a
 * person with keys is concerned: the environment first, then the profile in
 * ~/.aws/credentials that AWS_PROFILE names, or `default`.
 *
 * uno stores nothing. What it can read is what the person already set up for
 * every other tool, and it is read in the engine's process, so a key never
 * reaches the page that draws the grid.
 *
 * SSO and credential_process profiles are not followed. Each is a program to
 * run and a token to exchange, and a profile that needs one is refused by name
 * with the command that turns it into keys this can read.
 */
export function awsCredentials(
  env: Record<string, string | undefined> = process.env,
): () => Promise<AwsCredentials> {
  let kept: { at: number; creds: AwsCredentials } | undefined;

  return async () => {
    if (kept !== undefined && Date.now() - kept.at < CREDENTIALS_MS) return kept.creds;

    const profile = env["AWS_PROFILE"] ?? env["AWS_DEFAULT_PROFILE"] ?? "default";
    const aws = join(homedir(), ".aws");
    const config = await ini(env["AWS_CONFIG_FILE"] ?? join(aws, "config"));
    const fromConfig = config.get(profile === "default" ? "default" : `profile ${profile}`);
    const region =
      env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? fromConfig?.get("region") ?? "us-east-1";

    let creds: AwsCredentials | undefined;
    const id = env["AWS_ACCESS_KEY_ID"];
    const secret = env["AWS_SECRET_ACCESS_KEY"];
    if (id !== undefined && id !== "" && secret !== undefined && secret !== "") {
      creds = {
        accessKeyId: id,
        secretAccessKey: secret,
        sessionToken: env["AWS_SESSION_TOKEN"],
        region,
      };
    } else {
      const file = await ini(env["AWS_SHARED_CREDENTIALS_FILE"] ?? join(aws, "credentials"));
      const p = file.get(profile);
      const key = p?.get("aws_access_key_id") ?? fromConfig?.get("aws_access_key_id");
      const sec = p?.get("aws_secret_access_key") ?? fromConfig?.get("aws_secret_access_key");
      if (key !== undefined && sec !== undefined) {
        const token = p?.get("aws_session_token") ?? fromConfig?.get("aws_session_token");
        creds = { accessKeyId: key, secretAccessKey: sec, sessionToken: token, region };
      } else if (
        fromConfig?.has("sso_session") === true ||
        fromConfig?.has("sso_start_url") === true
      ) {
        throw new Error(
          `the AWS profile ${profile} signs in through SSO, which uno does not follow yet · ` +
            `run \`aws configure export-credentials --profile ${profile} --format env\` and start uno from that shell`,
        );
      }
    }
    if (creds === undefined) {
      throw new Error(
        `no AWS credentials · set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or put keys for the ${profile} profile in ~/.aws/credentials`,
      );
    }
    kept = { at: Date.now(), creds };
    return creds;
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
