// The store: FileHandler for opening files, Lister for browsing places, and
// FileStore for the folders uno writes its own files to.
//
// Every file is opened through a handler a platform lists, and every place is
// browsed through a lister it lists. A kind of place outside both lists is
// refused by name.

import { compareStrings } from "../go/index.ts";
import type { Connection, Formula } from "../library/index.ts";
import {
  EXT,
  fileName,
  formatConnection,
  formatFormula,
  parseConnection,
  parseFormula,
  stampConnection,
} from "../library/index.ts";
import { JOINS, OPENS, claim } from "./claim.ts";
// Type only. The handler that opens parts is re-exported below.
import type { HeaderMode, Part } from "./multi.ts";
// Type only, so the run-time import graph stays one-way with the plugin
// package.
import type { Provider } from "../plugin/index.ts";

// Browsing is its own interface, in store/list.ts.
export { listWith, statWith } from "./list.ts";
export type { Entry, Listing, Lister } from "./list.ts";

// Several files read as one, in store/multi.ts. It opens its parts through
// openWith.
export { multiFiles, multiOf, multiProvider, openMulti, partMap } from "./multi.ts";
export type { Extent, HeaderMode, MultiSource, Part, PartMap, Span } from "./multi.ts";

/**
 * FileStore is a folder uno keeps its own files in: the formula library and
 * the connections.
 *
 * Reading goes through `files`. `write` is atomic: a failure leaves the file
 * that was there untouched and the folder otherwise as it was.
 */
export interface FileStore {
  /** The handlers files in the store are opened with. */
  files: readonly FileHandler[];
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** The names of the entries directly in dir, or an empty list for a
   * missing directory. */
  list(dir: string): Promise<string[]>;
}

/**
 * ByteSource is a file read a range at a time. A desktop reads a descriptor
 * at an offset, a browser slices a File, a test slices a Blob.
 */
export interface ByteSource {
  readonly size: number;
  /**
   * Which bytes these are, where the place can say: an S3 VersionId, or an
   * ETag in its quotes. Undefined for a file on disk.
   */
  readonly version?: string;
  /** Up to `length` bytes from `offset`. Fewer only at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * FileRef says where a source's bytes are: one file, or several read as one.
 * `name` is what the source is called. `ingest` picks a decoder by it.
 */
export type FileRef = SingleRef | PartsRef;

/**
 * SingleRef is one file: a path, which may be a URL like s3://bucket/key, or
 * a Blob the caller holds.
 */
export type SingleRef =
  | {
      name: string;
      path: string;
      /**
       * Which version of the file to read, where a save recorded one. A
       * handler that lacks versions reads the file as it is now and reports
       * which version that was.
       */
      version?: string;
    }
  | { name: string; blob: Blob };

/**
 * PartsRef is several files read as one table: an ordered list of parts under
 * a name of its own. Each part is a SingleRef and is opened as it would be
 * alone. A part may carry the version and extent an earlier open recorded.
 *
 * It is plain data, and it is everything `openMulti` needs.
 */
export interface PartsRef {
  name: string;
  /** The files, in the order their rows are read. At least one. */
  parts: readonly Part[];
  /** Whether the parts have a header row. */
  header: HeaderMode;
  /** Whether a `_file` column shows which part each row came from. */
  fileColumn?: boolean;
}

/**
 * FileHandler opens one kind of place a file can be: a disk, a bucket, a
 * Blob. It only opens, and only for reading. `handles` looks at the ref only,
 * so a handler can be picked for a path read out of a .uno.
 */
export interface FileHandler {
  /** The kind of place, as an error names it. */
  readonly label: string;
  /** Whether `ref` is one this handler opens. */
  handles(ref: FileRef): boolean;
  /** The file, read a range at a time. Throws, naming it, when it is
   * missing or the read fails. */
  open(ref: FileRef): Promise<ByteSource>;
}

/**
 * A path with a URL scheme in front of it: s3://, https://. The scheme is at
 * least two characters, so a Windows drive letter stays a local path.
 */
const REMOTE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/** isRemote says whether a path has a URL scheme. */
export function isRemote(path: string): boolean {
  return REMOTE.test(path);
}

/**
 * openWith opens a ref through the first handler that claims it. Throws,
 * naming the kinds this build reads, when none does. A ref with parts is
 * refused as "opens several files as one".
 */
export async function openWith(
  handlers: readonly FileHandler[],
  ref: FileRef,
): Promise<ByteSource> {
  const where = "path" in ref ? ref.path : ref.name;
  const refusal = "parts" in ref ? JOINS : OPENS;
  return claim(handlers, where, (h) => h.handles(ref), refusal).open(ref);
}

/**
 * readAll opens a ref and reads all of it. For small files read at once: a
 * formula, a .uno, a config file.
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
 * blobFiles opens Blobs: files dropped into a browser, and bytes a test
 * holds. It claims every ref with a `blob`.
 */
export function blobFiles(): FileHandler {
  return {
    label: "dropped files",
    handles: (ref) => "blob" in ref,
    open: (ref) =>
      "blob" in ref
        ? Promise.resolve(blobSource(ref.blob))
        : Promise.reject(new Error(`${"path" in ref ? ref.path : ref.name}: not a dropped file`)),
  };
}

/** blobProvider is the dropped-file provider: blobFiles, for opening only. */
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
 * bytesSource reads bytes already in memory in place, such as a source
 * carried inside a .uno.
 */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (offset, length) =>
      Promise.resolve(bytes.subarray(offset, Math.min(offset + length, bytes.length))),
    close: () => Promise.resolve(),
  };
}

/** What loadLibrary read, and what failed. */
export interface LibraryLoad {
  formulas: Formula[];
  /** One error per file that failed to load. `formulas` still holds the
   * rest. */
  failed: Error[];
}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * loadLibrary reads every .unof in dir as a formula, sorted by id. A file that
 * fails to parse becomes an entry in `failed` and the rest still load. A
 * missing directory is an empty library.
 */
export async function loadLibrary(store: FileStore, dir: string): Promise<LibraryLoad> {
  const { read, failed } = await readEach(store, dir, parseFormula, false);
  const formulas = read.map((r) => r.value);

  formulas.sort((a, b) => compareStrings(a.id, b.id));
  return { formulas, failed };
}

/**
 * saveFormula writes f to <dir>/<id>.unof through the store's atomic write
 * and returns the stamped copy.
 */
export async function saveFormula(store: FileStore, dir: string, f: Formula): Promise<Formula> {
  const name = fileName(f.id);
  const { text, stamped } = formatFormula(f);
  await store.write(join(dir, name), encoder.encode(text));
  return stamped;
}

/**
 * readEach reads every .unof in dir through `parse`. A file that fails is
 * kept as its Error in `failed`. Files are read in name order where `sorted`,
 * and in the folder's order otherwise.
 */
async function readEach<T>(
  store: FileStore,
  dir: string,
  parse: (name: string, text: string) => T,
  sorted: boolean,
): Promise<{ read: Array<{ file: string; value: T }>; failed: Error[] }> {
  const read: Array<{ file: string; value: T }> = [];
  const failed: Error[] = [];
  const listed = await store.list(dir);
  for (const entry of sorted ? listed.toSorted(compareStrings) : listed) {
    if (!entry.toLowerCase().endsWith(EXT)) continue;
    try {
      const bytes = await readAll(store.files, { name: entry, path: join(dir, entry) });
      read.push({ file: entry, value: parse(entry, decoder.decode(bytes)) });
    } catch (err) {
      failed.push(err as Error);
    }
  }
  return { read, failed };
}

/** What loadConnections read, and what failed. */
export interface ConnectionLoad {
  connections: Connection[];
  /** One error per file that failed to load. */
  failed: Error[];
}

/**
 * loadConnections reads every .unof in dir as a connection, sorted by id. A
 * file that fails to parse becomes an entry in `failed`, and a missing
 * directory loads as empty.
 *
 * Only one file loads per id. The file named `<id>.unof` wins, since that is
 * the one a save writes. Otherwise the first in name order wins. Every other
 * file with that id becomes an entry in `failed` naming both files.
 */
export async function loadConnections(store: FileStore, dir: string): Promise<ConnectionLoad> {
  const loaded = await readEach(store, dir, parseConnection, true);
  const read = loaded.read.map(({ file, value }) => ({ file, connection: value }));
  const failed = loaded.failed;

  // The file a save writes to goes first for its id. The rest keep name order.
  const own = (r: { file: string; connection: Connection }): number =>
    r.file === r.connection.id + EXT ? 0 : 1;
  const byId = new Map<string, string>();
  const connections: Connection[] = [];
  for (const { file, connection } of read.toSorted((a, b) => own(a) - own(b))) {
    const first = byId.get(connection.id);
    if (first !== undefined) {
      failed.push(
        new Error(
          `${file} is connection ${JSON.stringify(connection.id)} too, and ${first} already is · rename one of their ids`,
        ),
      );
      continue;
    }
    byId.set(connection.id, file);
    connections.push(connection);
  }
  connections.sort((a, b) => compareStrings(a.id, b.id));
  return { connections, failed };
}

/**
 * saveConnection writes c to <dir>/<id>.unof through the store's atomic write
 * and returns the stamped copy. formatConnection runs before the write, so a
 * connection it refuses leaves the file as it was.
 */
export async function saveConnection(
  store: FileStore,
  dir: string,
  c: Connection,
): Promise<Connection> {
  const name = fileName(c.id, "connection");
  const stamped = stampConnection(c);
  const text = formatConnection(stamped);
  await store.write(join(dir, name), encoder.encode(text));
  return stamped;
}

/**
 * Connections is the loaded connections, and a way to read their folder
 * again. Both the handler signing a request and the workspace read it.
 */
export interface Connections {
  /** The connections the last load read, in id order. */
  readonly all: readonly Connection[];
  /** Reads the folder again. The result replaces `all`. */
  load(): Promise<ConnectionLoad>;
}

/**
 * connectionsIn keeps the connections of one folder. It holds none until the
 * first load. Loads run one at a time, in the order they were asked for.
 */
export function connectionsIn(store: FileStore, dir: string): Connections {
  let all: readonly Connection[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get all() {
      return all;
    },
    load() {
      const run = queue.then(async () => {
        const read = await loadConnections(store, dir);
        all = read.connections;
        return read;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function join(dir: string, name: string): string {
  if (dir === "") return name;
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}
