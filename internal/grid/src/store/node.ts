// The Node implementation of FileStore, the disk's handler and lister, and the
// only file in the package that imports node:fs.
//
// Its `write` is internal/safefile/write.go: build a sibling temp file, fsync
// it, and rename over the target, so an interrupted write loses the new content
// rather than the content already there.
//
// The handler and the lister are in one module because they are one place: what
// `localFiles` opens is what `diskLister` browses, which is also why the guard
// test in tests/store/opens.test.ts allows node:fs here and nowhere else.

import type { Dirent, Stats } from "node:fs";
import { constants } from "node:fs";
import { mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { compareStrings } from "../go/index.ts";
import type { Provider } from "../plugin/index.ts";
import type { ByteSource, Entry, FileHandler, FileStore, Lister, Listing } from "./index.ts";
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
 * diskProvider is this machine's disks plugged in as one thing: the handler that
 * opens a path and the lister that browses the folder it came out of.
 */
export function diskProvider(): Provider {
  return { name: "disk", label: "local files", files: localFiles(), browse: diskLister() };
}

/**
 * How many entries one page of a disk listing holds.
 *
 * A thousand, which is what one ListObjectsV2 answers with, so the panel scrolls
 * a folder and a prefix at the same rate and neither feels like the other's
 * special case.
 */
const PAGE = 1_000;

/**
 * diskLister browses this machine's disks: one `readdir` for what is there, and
 * a `stat` for each entry of the page a caller actually asked for.
 *
 * `page` is a parameter because the page size is the lister's own -- `list` is
 * handed a path and a cursor and nothing else -- and a test that has to see a
 * second page should not have to write a thousand files to get one.
 */
export function diskLister(page: number = PAGE): Lister {
  return {
    label: "local files",
    // The same rule localFiles opens by, and for the same reason: a path with a
    // scheme in front of it belongs to whoever claims that scheme.
    handles: (path) => !isRemote(path),
    list: (dir, cursor) => listDir(dir, cursor, page),
    stat: statEntry,
  };
}

/** One thing readdir found, once it is known what it is. */
interface Row {
  name: string;
  folder: boolean;
  /** The stat that followed a symlink, kept so the page need not ask again. */
  linked: Stats | undefined;
}

/**
 * pageKey is the order a disk listing comes back in, written as one string:
 * folders first, then by name.
 *
 * It is also the cursor, which is why it is a string and not a pair. A cursor
 * that were an index would slide by one when somebody saved a file into the
 * folder mid-scroll and a page would skip an entry; a key means "the entries
 * from here on" and stays true whatever happened to the folder meanwhile. `d`
 * sorts before `f`, so comparing two keys is comparing folder-ness and then the
 * name, with no second comparison to keep in step with this one.
 */
function pageKey(row: { name: string; folder: boolean }): string {
  return `${row.folder ? "d" : "f"}:${row.name}`;
}

/**
 * listDir reads one page of a folder.
 *
 * Every page costs the whole readdir, and the order is why rather than the
 * paging: folders come first, so the last name in the directory can belong on
 * the first page, and nothing can be handed back until all of them have been
 * seen. A filesystem has no continuation token to hold that place with either.
 * What paging does save is the stats, which is where the time actually goes --
 * a folder of 200,000 files costs one readdir and the fifty sizes on screen,
 * not 200,000 of them.
 *
 * A folder that is not there throws rather than answering empty, which is the
 * opposite of what `nodeStore.list` does with the formula library. A person who
 * has never written a formula has no folder and does not need to hear about it;
 * a person who browsed somewhere that has gone does, because an empty listing
 * would say the folder is there and has nothing in it.
 */
async function listDir(dir: string, cursor: string | undefined, page: number): Promise<Listing> {
  const found = await readdir(dir, { withFileTypes: true });

  // A symlink is shown as what it points to, so following it is part of
  // ordering the folder and not part of reading the page: only a stat says
  // whether a link is a folder, and folders come first. They go together rather
  // than one after another, so a folder of two hundred links is one round of
  // waiting and not two hundred.
  const links = found.filter((e) => e.isSymbolicLink());
  const followed = await Promise.all(links.map((e) => statOrNothing(join(dir, e.name))));
  const pointsAt = new Map(links.map((e, i) => [e.name, followed[i]]));

  const rows: Row[] = [];
  for (const e of found) {
    const row = rowOf(e, pointsAt.get(e.name));
    if (row !== undefined) rows.push(row);
  }
  rows.sort((a, b) => compareStrings(pageKey(a), pageKey(b)));

  // -1 is the end: a cursor naming an entry that has since been deleted, or one
  // from a folder that has shrunk, is the last page rather than the first.
  const at =
    cursor === undefined ? 0 : rows.findIndex((r) => compareStrings(pageKey(r), cursor) >= 0);
  const start = at < 0 ? rows.length : at;

  const entries = await Promise.all(
    rows.slice(start, start + page).map((row) => entryOf(dir, row)),
  );
  const after = rows[start + page];
  return after === undefined ? { entries } : { entries, next: pageKey(after) };
}

/**
 * rowOf says what a directory entry is, or that it is nothing worth listing.
 *
 * Sockets, fifos and devices are left out. Nothing in ingest reads one, and a
 * fifo is worse than useless in a browser: opening it would hang on a writer
 * that may never come, so the safest thing to do with one is not offer it.
 *
 * A link that cannot be followed -- dangling, a loop, a directory this person
 * may not stat -- is listed as a file with no size. It is in the folder and `ls`
 * shows it, and a panel that draws a dash for a size it was not given already
 * has somewhere to put it.
 */
function rowOf(e: Dirent, linked: Stats | undefined): Row | undefined {
  if (e.isSymbolicLink()) {
    if (linked === undefined) return { name: e.name, folder: false, linked: undefined };
    if (!linked.isDirectory() && !linked.isFile()) return undefined;
    return { name: e.name, folder: linked.isDirectory(), linked };
  }
  if (e.isDirectory()) return { name: e.name, folder: true, linked: undefined };
  if (e.isFile()) return { name: e.name, folder: false, linked: undefined };
  return undefined;
}

/**
 * entryOf fills in the size and the time for one entry of the page.
 *
 * `version` stays absent: a disk has nothing like an ETag, and task 3.3's
 * change test is written to compare sizes where there are no versions. Inventing
 * one out of the mtime would make it compare something it was told it could not
 * have.
 *
 * A directory gets no `bytes`. The size of a directory is the size of the list
 * of names in it, which is a number about the filesystem and not about anything
 * a person browsing is looking for.
 */
async function entryOf(dir: string, row: Row): Promise<Entry> {
  const path = join(dir, row.name);
  const st = row.linked ?? (await statOrNothing(path));
  return {
    name: row.name,
    path,
    folder: row.folder,
    ...(st === undefined ? {} : { modified: st.mtime }),
    ...(st === undefined || row.folder ? {} : { bytes: st.size }),
  };
}

/**
 * statEntry is size and time now, for one path, without reading it.
 *
 * It follows a symlink, so it answers for what the link points to, the way a
 * listing shows it. A path that is not there throws as node wrote it: the
 * message already names the path, and the `code` on it is what callers here test
 * for.
 */
async function statEntry(path: string): Promise<Entry> {
  const st = await stat(path);
  return {
    name: basename(path),
    path,
    folder: st.isDirectory(),
    modified: st.mtime,
    ...(st.isDirectory() ? {} : { bytes: st.size }),
  };
}

/**
 * statOrNothing is a stat whose failure is an answer.
 *
 * One entry that cannot be statted -- deleted between the readdir and here, a
 * link with no target, a mount that is not answering -- costs its own size and
 * not the folder it is in.
 */
async function statOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
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
