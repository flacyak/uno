// The seam between the pure core and a machine.
//
// Everything under src/ but this module works on bytes and strings, so it runs
// unchanged in a browser. What a desktop adds is a filesystem, and this is the
// whole of what the core needs from one: three methods, because a fourth would
// be something the browser then has to pretend to have.

import { compareStrings } from "../go/index.ts";
import type { Formula } from "../library/index.ts";
import { EXT, fileName, formatFormula, parseFormula } from "../library/index.ts";

/**
 * FileStore is what a machine offers the core.
 *
 * `write` must be atomic: a failure anywhere in it has to leave the file that
 * was already there untouched, and leave no half-written part behind for the
 * next person to find. Saving is the one operation in uno that can destroy
 * something, and every failure mode worth designing for resolves to the same
 * promise -- the previously saved file is still there.
 */
export interface FileStore {
  read(path: string): Promise<Uint8Array>;
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

/** blobSource reads a Blob: a File a person dropped, or bytes a test holds. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) =>
      new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
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
      const bytes = await store.read(join(dir, entry));
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
