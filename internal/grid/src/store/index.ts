// The seam between the pure core and a machine.
//
// Everything under src/ but this module works on bytes and strings, so it runs
// unchanged in a browser. What a machine adds is somewhere files are, and every
// file uno reads -- a source, a .uno, a formula in the library -- is opened
// through a FileHandler, and every place uno browses is browsed through a
// Lister. There is no second way in: a platform that has not listed a handler
// or a lister for a kind of place cannot reach it, and says so by name.

import { compareStrings } from "../go/index.ts";
import type { Formula } from "../library/index.ts";
import { EXT, fileName, formatFormula, parseFormula } from "../library/index.ts";
import { OPENS, claim } from "./claim.ts";
// Type only, and one way on purpose: the plugin package composes what is here,
// and nothing here reaches back into it at run time.
import type { Provider } from "../plugin/index.ts";

// Browsing is its own interface, in its own module, and belongs to the same
// seam: a platform that lists no lister for a kind of place cannot browse it.
export { listWith, statWith } from "./list.ts";
export type { Entry, Listing, Lister } from "./list.ts";

/**
 * FileStore is a folder uno keeps files of its own in: the formula library.
 *
 * Reading goes through `files`, the same handlers every other open goes
 * through. What the store adds is the two things a handler never does, writing
 * and listing.
 *
 * `write` must be atomic: a failure anywhere in it has to leave the file that
 * was already there untouched, and leave no half-written part behind for the
 * next person to find. Saving is the one operation in uno that can destroy
 * something, and every failure mode worth designing for resolves to the same
 * promise -- the previously saved file is still there.
 */
export interface FileStore {
  /** How files in the store are opened for reading. */
  files: readonly FileHandler[];
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** The names of the entries directly in dir, or an empty list where there is
   * no such directory. */
  list(dir: string): Promise<string[]>;
}

/**
 * ByteSource is a file read a piece at a time.
 *
 * It is what lets a file larger than memory open: nothing in the core asks for
 * the whole of one, so nothing has to hold it. A desktop reads a descriptor at
 * an offset, a browser slices a File, a test slices a Blob, and the core cannot
 * tell them apart.
 */
export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes from `offset`. Fewer only where the file ends. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * FileRef says where a file is without holding any of it: a path, which may be
 * a URL like s3://bucket/key, or a Blob the caller already holds -- a file
 * dropped into a browser, which has no path to give.
 *
 * The name is what the file is called, which is what `ingest` picks a decoder
 * by and what a tab says.
 */
export type FileRef = { name: string; path: string } | { name: string; blob: Blob };

/**
 * FileHandler opens one kind of place a file can be: a disk, a bucket, bytes
 * already in hand.
 *
 * It only opens, and only for reading. A source is a view of a file somebody
 * else owns, and the log is where every change to it lives, so nothing here
 * ever has a reason to write one back.
 *
 * A handler says which refs are its own by looking at them and nothing else,
 * so the engine can pick one for a path it read out of a .uno without asking
 * anybody. That is what lets one workspace hold a CSV off the desktop beside an
 * export in S3.
 */
export interface FileHandler {
  /** What a person would call this kind of place, for an error that names it. */
  readonly label: string;
  /** Whether `ref` is one this handler opens. */
  handles(ref: FileRef): boolean;
  /** The file, read a piece at a time. Throws, naming it, when it is not there
   * or not ours to read. */
  open(ref: FileRef): Promise<ByteSource>;
}

/**
 * A path with a scheme in front of it -- s3://, https:// -- rather than one on
 * this machine's disks. A Windows drive letter is one character, so C:\ is not
 * mistaken for one.
 */
const REMOTE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/** isRemote says whether a path names a place on a network rather than a disk. */
export function isRemote(path: string): boolean {
  return REMOTE.test(path);
}

/**
 * openWith opens a ref through the first handler that claims it.
 *
 * Refusing by name matters here more than anywhere: a .uno written on a
 * machine with S3 set up, opened on one without, has to say which kind of
 * place it cannot reach rather than "file not found".
 */
export async function openWith(
  handlers: readonly FileHandler[],
  ref: FileRef,
): Promise<ByteSource> {
  const where = "path" in ref ? ref.path : ref.name;
  return claim(handlers, where, (h) => h.handles(ref), OPENS).open(ref);
}

/**
 * readAll opens a ref through the handlers and reads the whole of it. It is for
 * the small files uno reads at once -- a formula, a .uno, a config file -- and
 * never for a source, which is read a piece at a time.
 */
export async function readAll(handlers: readonly FileHandler[], ref: FileRef): Promise<Uint8Array> {
  const file = await openWith(handlers, ref);
  try {
    return await file.read(0, file.size);
  } finally {
    await file.close();
  }
}

/**
 * blobFiles opens Blobs: files dropped into a browser, which have no path, and
 * bytes a test holds.
 *
 * It is a handler like the others so that accepting one is a platform's
 * decision. A desktop engine opens files by path and does not list it, so a
 * Blob that reaches one is refused by name rather than half-supported.
 */
export function blobFiles(): FileHandler {
  return {
    label: "dropped files",
    handles: (ref) => "blob" in ref,
    open: (ref) =>
      "blob" in ref
        ? Promise.resolve(blobSource(ref.blob))
        : Promise.reject(new Error(`${ref.path}: not a dropped file`)),
  };
}

/**
 * blobProvider is the dropped-file provider: a handler and nothing to browse.
 *
 * It is the case that proves `browse` is allowed to be missing. A Blob has no
 * folder it came from and no path to name one with, so there is nothing here a
 * person could look in.
 */
export function blobProvider(): Provider {
  return { name: "blob", label: "dropped files", files: blobFiles() };
}

/** blobSource reads a Blob: a File a person dropped, or bytes a test holds. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
    close: () => Promise.resolve(),
  };
}

/**
 * bytesSource reads bytes already in memory without copying them: the source a
 * .uno carries, once the container has been read.
 *
 * It is not a way of opening a file. The container it came out of was opened
 * through a handler, and these are a piece of what that open read.
 */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(offset + length, bytes.length))),
    close: () => Promise.resolve(),
  };
}

/** What `loadLibrary` could not read, alongside what it could. */
export interface LibraryLoad {
  formulas: Formula[];
  /** One entry per file that failed, naming it. Both halves of the result are
   * meant to be used: failures here do not mean the list is empty. */
  failed: Error[];
}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * loadLibrary reads every .unof in dir.
 *
 * One bad file costs one formula and not the library: it returns everything it
 * could read, and alongside it the failures, so the drawer still opens with the
 * other seventeen formulas in it and the caller still has something specific to
 * say about the missing one.
 *
 * A directory that does not exist is an empty library rather than a failure. A
 * person who has never written a formula has no folder, and that is not a fault
 * worth reporting to them -- which is why `list` answers with an empty list
 * rather than raising.
 */
export async function loadLibrary(store: FileStore, dir: string): Promise<LibraryLoad> {
  const formulas: Formula[] = [];
  const failed: Error[] = [];

  for (const entry of await store.list(dir)) {
    if (!entry.toLowerCase().endsWith(EXT)) continue;
    try {
      const path = join(dir, entry);
      const bytes = await readAll(store.files, { name: entry, path });
      formulas.push(parseFormula(entry, decoder.decode(bytes)));
    } catch (err) {
      failed.push(err as Error);
    }
  }

  // Sorted by id, so the caller is handed a stable order instead of whatever
  // the directory happened to give. Which order they are shown in is the
  // caller's decision: recency is a fact about this person on this machine and
  // is deliberately not in these files.
  formulas.sort((a, b) => compareStrings(a.id, b.id));
  return { formulas, failed };
}

/**
 * saveFormula writes f to <dir>/<id>.unof and hands back the stamped copy.
 *
 * It goes through the store's atomic write because this is the save that runs
 * on a debounce while someone is still typing, which is exactly when a crash is
 * most likely. An interrupted autosave loses the keystroke rather than the
 * formula that was already there.
 */
export async function saveFormula(store: FileStore, dir: string, f: Formula): Promise<Formula> {
  const name = fileName(f.id);
  const { text, stamped } = formatFormula(f);
  await store.write(join(dir, name), encoder.encode(text));
  return stamped;
}

function join(dir: string, name: string): string {
  if (dir === "") return name;
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}
