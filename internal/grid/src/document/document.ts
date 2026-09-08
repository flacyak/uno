// Package document reads and writes the .uno container: a zip holding the bytes
// of every file you were given, deflated, alongside the log of what you did to
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
export const FORMAT_VERSION = 4;

/** What a log of nothing but single-cell edits needs, which is every file uno
 * wrote before the recogniser existed. */
export const BASE_VERSION = 1;

/** What a log carrying an induced column rule needs, which is every file the
 * recogniser wrote before formulas existed. */
export const RULE_VERSION = 2;

/** What a log carrying a note, a binding or an unbinding needs, which is every
 * file written before a workspace could hold more than one source. */
export const FORMULA_VERSION = 3;

/**
 * What a workspace of more than one source needs. The manifest lists its
 * sources and every line of the log names the one it changed, which is a layout
 * a build before it would read as one source and a log it cannot place.
 */
export const SOURCES_VERSION = 4;

export const GENERATOR = "uno 0.2.0";

/**
 * The fixed entries. The source entries are not fixed, because calling a TSV's
 * bytes source.csv would be a small lie told to everyone who unzips the file.
 */
export const MANIFEST_ENTRY = "uno.json";
export const STATE_ENTRY = "sheet/state.json";
export const LOG_ENTRY = "edits/log.jsonl";

/** Where a one-source workspace keeps its bytes, as data/source.csv. */
const SOURCE_STEM = "data/source";
/** Where a workspace of several keeps them, one entry each, as data/source/<id>.csv. */
const SOURCE_DIR = "data/source/";

/**
 * Source is the provenance of one file's raw bytes, as uno.json records it.
 *
 * Name and not path: a path is precisely the thing that stops being true when
 * the file travels. The name is kept because it is useful to display and
 * because `ingest` picks its decoder from the extension; nothing here is ever
 * resolved against a filesystem.
 *
 * The delimiter and encoding are deliberately absent. The reader derives them
 * from these same bytes with the same code that derived them the first time, so
 * a stored copy could only ever be a second opinion that disagrees.
 *
 * The rows and columns are the shape of the grid the bytes and the log add up
 * to. They are written so that a recents list or a file inspector can say how
 * big a workspace is without decoding it.
 */
export interface Source {
  /** What the log calls this source. Unique in its workspace, and never reused
   * for another file in it. */
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  entry: string;
  rows: number;
  cols: number;
}

/** Where the state entry is. */
export interface SheetRef {
  entry: string;
}

export interface EditsRef {
  count: number;
  entry: string;
}

/** Manifest is uno.json: what this file is, where each source's bytes came
 * from, and where the other entries live. */
export interface Manifest {
  format: number;
  generator: string;
  created: Date | undefined;
  modified: Date | undefined;
  sources: Source[];
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
 * State is what one source's grid looked like, not what it held. Everything
 * the data itself contains is reachable from the raw bytes and the log, so
 * nothing that can be replayed is written here.
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
 * Embedded is one source as a workspace holds it in memory: its bytes, and
 * what its grid looked like.
 *
 * The caller owns the facts the writer cannot see -- the id, the file's name,
 * and the shape of the grid the log builds. Everything else about the source
 * is measured from `raw` as it is written.
 */
export interface Embedded {
  id: string;
  name: string;
  raw: Uint8Array;
  rows: number;
  cols: number;
  state: State;
}

/**
 * Logged is one line of the log: an edit, and the source it changed.
 *
 * The log is one list for the whole workspace, in the order the edits were
 * made, because that order is what a person reads back. Each edit's `seq` is
 * its place in its own source's log, which is what replay numbers it by.
 */
export interface Logged {
  source: string;
  edit: Edit;
}

/**
 * Document is one .uno in memory, and one workspace.
 *
 * The split matters at save time. `writeDocument` consumes manifest, sources,
 * log and extra, all of which are values that can be snapshotted and handed
 * over, so the deflate can run somewhere else while the person keeps typing.
 * `sheets` is live and mutable, and only `readDocument` ever sets it.
 */
export interface Document {
  /**
   * Derived: the writer fills in the format, the generator, the timestamps,
   * the sources, the counts and the entry names from what it actually writes,
   * so the file cannot come to describe a different file. The one fact the
   * caller owns is `created`.
   */
  manifest: Manifest;
  /** In the order the workspace shows them. Never empty. */
  sources: Embedded[];
  /** The id of the source that was showing. */
  active: string;
  log: Logged[];

  /**
   * Entries this build did not recognise, carried through to the next save.
   *
   * An older uno opening a file written by a newer one must not quietly drop
   * what it could not read and then write that loss back over the file.
   */
  extra: Map<string, Uint8Array>;

  /** Each source replayed, by id. Set by `readDocument` and ignored by the writer. */
  sheets?: Map<string, Sheet>;
}

/**
 * sourceEntry names a source's entry after the file it holds, so `unzip -l`
 * on a workspace opened from a TSV says data/source.tsv.
 *
 * A workspace of one source keeps the entry every earlier build wrote. One of
 * several gives each its own, named by id.
 */
export function sourceEntry(name: string, id?: string): string {
  const dot = name.lastIndexOf(".");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const ext = dot < 0 || dot < slash ? "" : name.slice(dot).toLowerCase();
  return (id === undefined ? SOURCE_STEM : SOURCE_DIR + id) + (ext === "" ? ".csv" : ext);
}

/** The characters an id keeps. Anything else becomes a dash, so an id is safe
 * as a zip entry name and reads the same in a log line. */
const ID_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * sourceId names a source after its file, as the log will call it:
 * google-ads for Google Ads.csv.
 *
 * A second file of the same name is google-ads_2, the way a repeated column
 * name is told apart, so two exports both called export.csv stay two sources.
 */
export function sourceId(name: string, taken: Iterable<string>): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = (dot > 0 ? file.slice(0, dot) : file)
    .replace(ID_UNSAFE, "-")
    .replace(/^[-.]+|-+$/g, "")
    .toLowerCase();
  const base = stem === "" ? "source" : stem;

  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!used.has(id)) return id;
  }
}

/** logOf is one source's edits, in order: what its sheet replays. */
export function logOf(log: readonly Logged[], id: string): Edit[] {
  return log.filter((l) => l.source === id).map((l) => l.edit);
}

/** An empty manifest, for a workspace that has never been saved. */
export function newManifest(): Manifest {
  return {
    format: 0,
    generator: "",
    created: undefined,
    modified: undefined,
    sources: [],
    sheet: { entry: "" },
    edits: { count: 0, entry: "" },
  };
}
