// Package document reads and writes the .uno container: a zip holding the log of
// what you did to each of your files, and, for each file, either where it is or
// a copy of it.
//
// Pointing rather than copying is what lets a workspace hold sources bigger than
// a zip has any business carrying. A workspace of a 30 GB ledger and four 2 GB
// exports is a few kilobytes of JSON, saves instantly, and costs nothing to keep
// a dozen copies of. What it gives up is travelling alone: a .uno that points at
// /home/you/exports opens on your machine and nowhere else, so a source uno
// cannot name by path -- bytes dropped into a browser, with no file behind them
// -- is carried instead.
//
// A pointer that no longer resolves is not a broken file. The source keeps its
// id, its edits and its place in the log; it simply has no grid until somebody
// points it at a file again. Losing a path must never cost the work done through
// it.
//
// It is a codec and not a file reader. `readDocument` takes bytes and
// `writeDocument` returns them, so the same code serves the desktop, where a
// FileStore puts them on a disk, and the browser, where there is no disk to put
// them on. Nothing here opens the file a source points at: it hands the path
// back, and the engine does.

import type { Edit } from "../sheet/index.ts";
import type { Sheet } from "../sheet/index.ts";
import { against, dirOf, relativeTo } from "./path.ts";

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
export const FORMAT_VERSION = 5;

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

/**
 * What a workspace that points at a file needs. A build before it reads every
 * source as one it carries, finds no entry where the manifest promised bytes,
 * and has no idea there is a path to try instead.
 */
export const POINTED_VERSION = 5;

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
 * Source is where one file is, as uno.json records it.
 *
 * Exactly one of `entry` and `path` is set. An entry is a copy of the file
 * inside this zip. A path is where the file was when the workspace was saved,
 * relative to the .uno when the file sits under its folder and absolute
 * otherwise.
 *
 * The name is kept either way, because it is what the tab says and because
 * `ingest` picks its decoder from the extension. For a pointed-at source it is
 * also what identifies the file after somebody has moved it: the name is the
 * thing a person recognises when uno asks them where it went.
 *
 * The delimiter and encoding are deliberately absent. The reader derives them
 * from the same bytes with the same code that derived them the first time, so a
 * stored copy could only ever be a second opinion that disagrees.
 */
export interface Source {
  /** What the log calls this source. Unique in its workspace, and never reused
   * for another file in it. */
  id: string;
  name: string;

  /**
   * The file's size. For a carried source it is the length of the entry; for a
   * pointed-at one it is what the file measured at the save.
   *
   * That makes it the cheap test for "is this still the file the log was
   * written against", and the only one worth running: hashing 30 GB to open a
   * workspace would cost more than every other part of opening it put together.
   */
  bytes: number;

  /** Over the carried bytes. Empty for a pointed-at source, which is not read
   * until the engine opens it. */
  sha256: string;

  /** The zip entry holding a copy of the file, or "" for a pointed-at source. */
  entry: string;

  /** Where the file is, or "" for a carried source. */
  path: string;

  /**
   * The shape of the grid the file and the log add up to, so a recents list or
   * a file inspector can say how big a workspace is without decoding it.
   *
   * For a pointed-at source still being indexed at the save, `rows` is as far
   * as the index had got. Nothing replays against it -- the engine counts the
   * rows itself -- so it is a number to show and not one to trust.
   */
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
 * Held is one source as a workspace holds it: where its bytes are, and what its
 * grid looked like.
 *
 * Exactly one of `raw` and `path` is set, and which one decides whether the save
 * copies the file or points at it. The caller owns the facts the writer cannot
 * see -- the id, the file's name, the shape of the grid the log builds. What can
 * be measured is measured as it is written.
 */
export interface Held {
  id: string;
  name: string;
  /** The file's bytes, for a source the workspace carries. */
  raw?: Uint8Array;
  /** Where the file is, absolute, for a source the workspace points at. */
  path?: string;
  /** What the file measured, for a pointed-at source. Taken from `raw` for a
   * carried one. */
  bytes?: number;
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
  sources: Held[];
  /** The id of the source that was showing. */
  active: string;
  log: Logged[];

  /**
   * Where the .uno itself is, so a source under the same folder is pointed at
   * relative to it and the folder can be copied whole.
   *
   * Empty when that is not known -- a browser download has no path until after
   * it is written -- and every pointer is then absolute. `readContainer` takes
   * the same path and reads the relative ones back from it.
   */
  at: string;

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

/**
 * storedPath is what the manifest writes down for a source at `file`, given the
 * .uno going to `at`: relative where the file sits under the workspace's own
 * folder, absolute everywhere else.
 */
export function storedPath(file: string, at: string): string {
  return relativeTo(file, dirOf(at)) || file;
}

/** resolvedPath is where a stored path points, read from the .uno at `at`. */
export function resolvedPath(stored: string, at: string): string {
  return against(stored, dirOf(at));
}
