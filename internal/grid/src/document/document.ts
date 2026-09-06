// Package document reads and writes the .uno container: a zip holding the bytes
// you were originally given, deflated, alongside the log of what you did to
// them.
//
// It consults nothing outside the file it was handed -- no original, no stored
// path, no network -- which is what lets a workspace open on a machine that has
// never seen the CSV it was made from.
//
// It is a codec and not a file reader. `readDocument` takes bytes and
// `writeDocument` returns them, so the same code serves the desktop, where a
// FileStore puts them on a disk, and the browser, where there is no disk to put
// them on.

import type { Edit } from "../sheet/index.ts";
import type { Sheet } from "../sheet/index.ts";

/**
 * FORMAT_VERSION is the highest layout this build reads, and the highest it
 * writes. It is the public API of uno: everything else can be reshaped on any
 * afternoon, but a .uno travels to other machines and stays readable there.
 *
 * A file declares the lowest version that can read it rather than this one, so
 * a workspace holding nothing an older uno could not replay still opens there.
 * The alternative is that adding an operation nobody used locks every file the
 * release touches out of every build before it.
 */
export const FORMAT_VERSION = 3;

/** What a log of nothing but single-cell edits needs, which is every file uno
 * wrote before the recogniser existed. */
export const BASE_VERSION = 1;

/** What a log carrying an induced column rule needs, which is every file the
 * recogniser wrote before formulas existed. */
export const RULE_VERSION = 2;

export const GENERATOR = "uno 0.2.0";

/**
 * The fixed entries. The source entry is not fixed, because calling a TSV's
 * bytes source.csv would be a small lie told to everyone who unzips the file.
 */
export const MANIFEST_ENTRY = "uno.json";
export const STATE_ENTRY = "sheet/state.json";
export const LOG_ENTRY = "edits/log.jsonl";
const SOURCE_DIR = "data/source";

/**
 * Source is the provenance of the raw bytes.
 *
 * Name and not path: a path is precisely the thing that stops being true when
 * the file travels. The name is kept because it is useful to display and
 * because `ingest` picks its decoder from the extension; nothing here is ever
 * resolved against a filesystem.
 *
 * The delimiter and encoding are deliberately absent. The reader derives them
 * from these same bytes with the same code that derived them the first time, so
 * a stored copy could only ever be a second opinion that disagrees.
 */
export interface Source {
  name: string;
  bytes: number;
  sha256: string;
  entry: string;
}

/**
 * SheetRef is the shape of the grid the raw bytes and the log add up to. It is
 * written so that a recents list or a file inspector can say how big a
 * workspace is without decoding it.
 */
export interface SheetRef {
  rows: number;
  cols: number;
  entry: string;
}

export interface EditsRef {
  count: number;
  entry: string;
}

/** Manifest is uno.json: what this file is, where its bytes came from, and
 * where the other entries live. */
export interface Manifest {
  format: number;
  generator: string;
  created: Date | undefined;
  modified: Date | undefined;
  source: Source;
  sheet: SheetRef;
  edits: EditsRef;
}

/** A position in the grid. It is where the person was, which is a fact about
 * the session rather than about the data. */
export interface Cell {
  row: number;
  col: number;
}

/**
 * ColumnFormula points a bound column at the library file it was written in.
 *
 * A reference that does not resolve is not an error: the column still computes,
 * and the drawer simply has nothing to open.
 */
export interface ColumnFormula {
  col: number;
  ref: string;
}

/**
 * State is what the grid looked like, not what it held. Everything the data
 * itself contains is reachable from the raw bytes and the log, so nothing that
 * can be replayed is written here.
 */
export interface State {
  active: Cell;

  /**
   * Which .unof in the person's own library each bound column came from, and
   * nothing else.
   *
   * The expression itself is in the log, because that is what has to be there
   * for the file to compute on a machine that has never seen the sender's
   * library -- the same promise the raw bytes make. This is the convenience
   * that makes "edit" beside a name find the formula again, so it belongs to
   * what the grid looked like rather than to what the workspace holds.
   */
  columnFormulas?: ColumnFormula[];
}

/**
 * Document is one .uno in memory, and one workspace.
 *
 * The split matters at save time. `writeDocument` consumes manifest, raw,
 * state, edits and extra, all of which are values that can be snapshotted and
 * handed over, so the deflate can run somewhere else while the person keeps
 * typing. `sheet` is live and mutable, and only `readDocument` ever sets it.
 */
export interface Document {
  /**
   * Mostly derived: the writer fills in the format, the generator, the
   * timestamps, the sizes, the hash, the counts and the entry names from what
   * it actually writes, so the file cannot come to describe a different file.
   * The caller owns the three facts the writer cannot see -- created,
   * source.name, and the sheet dimensions the log builds.
   */
  manifest: Manifest;
  raw: Uint8Array;
  state: State;
  edits: Edit[];

  /**
   * Entries this build did not recognise, carried through to the next save.
   *
   * An older uno opening a file written by a newer one must not quietly drop
   * what it could not read and then write that loss back over the file.
   */
  extra: Map<string, Uint8Array>;

  /** The replayed result, set by `readDocument` and ignored by the writer. */
  sheet?: Sheet;
}

/**
 * sourceEntry names the raw entry after the file it holds, so `unzip -l` on a
 * workspace opened from a TSV says data/source.tsv.
 */
export function sourceEntry(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const ext = dot < 0 || dot < slash ? "" : name.slice(dot).toLowerCase();
  return SOURCE_DIR + (ext === "" ? ".csv" : ext);
}

/** An empty manifest, for a workspace that has never been saved. */
export function newManifest(sourceName: string): Manifest {
  return {
    format: 0,
    generator: "",
    created: undefined,
    modified: undefined,
    source: { name: sourceName, bytes: 0, sha256: "", entry: "" },
    sheet: { rows: 0, cols: 0, entry: "" },
    edits: { count: 0, entry: "" },
  };
}
