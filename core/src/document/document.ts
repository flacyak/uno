/**
 * @fileoverview Package document reads and writes the .uno container: a zip
 * holding the manifest, the state, the edit log and, for each source, either a
 * copy of its bytes or a path to it.
 *
 * A source is one file or several files read as one table. A one-file source
 * is either carried (its bytes are in the zip) or pointed at (its path is in
 * the manifest). A parts source is always pointed at, one path per part, in
 * the order their rows are read.
 *
 * A pointer whose file has gone keeps its id, its edits and its place in the
 * log. It gets a grid again once it is pointed at a file.
 *
 * `readDocument` takes bytes and `writeDocument` returns bytes. The engine
 * opens the file a source points at.
 */

import type { Edit } from '@sheet';
import type { Sheet } from '@sheet';
import { nameParts } from '@ingest';
import type { FileRef, HeaderMode } from '@store';
import { against, dirOf, relativeTo } from './path.ts';

/**
 * FORMAT_VERSION is the highest layout this build reads and writes.
 *
 * A file declares the lowest version that can read it, so a workspace an
 * older build could replay still opens there.
 */
export const FORMAT_VERSION = 8;

/** A log of only single-cell edits. */
export const BASE_VERSION = 1;

/** A log that carries an apply (an induced column rule). */
export const RULE_VERSION = 2;

/** A log that carries a note, a bind or an unbind. */
export const FORMULA_VERSION = 3;

/**
 * A workspace of more than one source. The manifest lists its sources and
 * every log line names the one it changed.
 */
export const SOURCES_VERSION = 4;

/**
 * A workspace with a source that is pointed at by path.
 */
export const POINTED_VERSION = 5;

/**
 * A workspace with a source that is several files read as one.
 */
export const PARTS_VERSION = 6;

/**
 * A workspace with a source that says how its rows were read: a kind, a
 * compression or pinned columns.
 */
export const READ_VERSION = 7;

/**
 * A workspace with a source whose parts are read in row space, each on its
 * own and laid end to end, or that were found under a root.
 */
export const ROWS_VERSION = 8;

/**
 * OneOf is a closed set of values a uno.json field may hold: the guard that
 * checks a value, and every value, in the order a refusal lists them.
 */
export interface OneOf<T extends string> {
  is: (v: string) => v is T;
  known: readonly string[];
}

/** closed is the set of `members`' keys, which name every value of T. */
function closed<T extends string>(members: Record<T, true>): OneOf<T> {
  return {
    is: (v): v is T => Object.hasOwn(members, v),
    known: Object.keys(members),
  };
}

/**
 * Every header mode, as uno.json spells it. A mode added to HeaderMode has
 * to be added here.
 */
export const HEADER_MODES = closed<HeaderMode>({ first: true, none: true });

/**
 * How a source's rows sit in its bytes when they are not delimited text, as
 * uno.json spells it: "jsonl" for JSON Lines. A source with no kind is
 * delimited text. A kind joins here in the change that makes the engine read
 * it, so no build writes or accepts a kind it cannot read.
 */
export type SourceKind = 'jsonl';

/** The kinds this build reads. */
export const SOURCE_KINDS = closed<SourceKind>({ jsonl: true });

/**
 * What a file source's bytes were compressed with, as uno.json spells it.
 * None is read yet: a compression joins here in the change that makes the
 * engine read it.
 */
export type SourceCompression = never;

/** The compressions this build reads. */
export const SOURCE_COMPRESSIONS = closed<SourceCompression>({});

/**
 * How a parts source's files are laid end to end when not as bytes, as
 * uno.json spells it. A source with no join has its parts' bytes joined.
 */
export type PartsJoin = 'rows';

/** The joins this build reads. */
export const PARTS_JOINS = closed<PartsJoin>({ rows: true });

export const GENERATOR = 'uno 0.2.0';

/**
 * The fixed entry names. Source entries are named after the file they hold;
 * see `sourceEntry`.
 */
export const MANIFEST_ENTRY = 'uno.json';
export const STATE_ENTRY = 'sheet/state.json';
export const LOG_ENTRY = 'edits/log.jsonl';

/** Entry stem for a one-source workspace: data/source.csv. */
const SOURCE_STEM = 'data/source';
/** Entry folder for a workspace of several sources: data/source/<id>.csv. */
const SOURCE_DIR = 'data/source/';

/**
 * Source is one source as uno.json records it: one file, or several read as
 * one. `parts` is set only for the second.
 *
 * `name` is what the tab shows and what `ingest` picks a decoder from. The
 * reader derives the delimiter and encoding from the bytes.
 */
export type Source = FileSource | PartsSource;

/** The fields uno.json records for every source. */
interface SourceBase {
  /** What the log calls this source. Unique in its workspace. */
  id: string;
  name: string;

  /**
   * The id of the connection the source was read through, as a hint. "" when
   * none covered it, or when the parts disagree on which.
   *
   * Optional in the file: a format 5 reader ignores it.
   */
  connection: string;

  /**
   * The row and column count of the grid this source shows with its edits
   * applied, recorded so a reader can size the workspace from the manifest
   * alone. For a pointed-at source still being indexed at the save, `rows` is
   * the count indexed so far. On open the engine recounts from the file.
   */
  rows: number;
  cols: number;
}

/**
 * FileSource is a source that is one file.
 *
 * Exactly one of `entry` and `path` is set. `entry` names a copy of the file
 * inside the zip. `path` is where the file was at the save, relative to the
 * .uno when the file is under its folder and absolute otherwise.
 */
export interface FileSource extends SourceBase, ReadAs {
  /**
   * The file's size: the entry's length for a carried source, or what the
   * file measured at the save for a pointed-at one. The opener uses it to
   * check that a pointed-at file is still the one the log was written
   * against.
   */
  bytes: number;

  /** The hash of the carried bytes. "" for a pointed-at source. */
  sha256: string;

  /** The zip entry holding a copy of the file, or "" for a pointed-at source. */
  entry: string;

  /** Where the file is, or "" for a carried source. */
  path: string;

  /**
   * Which version of the file the log was made against, where the store can
   * say: an S3 VersionId, or an ETag in its quotes. "" otherwise.
   */
  version: string;

  parts?: never;
  header?: never;
  fileColumn?: never;
  join?: never;
  root?: never;
  partitions?: never;
}

/**
 * PartsSource is a source that is several files read as one table. The parts
 * are a fixed, ordered list: the log names rows by number, so the order
 * decides which row an edit lands on.
 */
export interface PartsSource extends SourceBase, ReadAs, JoinedAs {
  /** The files, in the order their rows are read. At least one. */
  parts: SourcePart[];
  /**
   * Whether the parts have a header row. Written only for delimited text,
   * the parts with no kind, and read as "first" for any other kind.
   */
  header: HeaderMode;
  /**
   * Whether a `_file` column shows which part each row came from. The
   * column's cells are computed at every open; the file holds only this flag.
   */
  fileColumn: boolean;

  bytes?: never;
  compression?: never;
  sha256?: never;
  entry?: never;
  path?: never;
  version?: never;
}

/**
 * SourcePart is one file of a PartsSource as uno.json records it.
 *
 * `bytes`, `skip` and `unterminated` are what the join measured at the save.
 * The next open places every part from them alone. A part whose size or
 * `version` has changed since is refused by name. `skip` and `unterminated`
 * are the byte join's, and are written only for parts joined as bytes.
 */
export interface SourcePart extends ReadAlone {
  /** The part's name when it differs from the last piece of its path, and
   * "" otherwise. `ingest` picks a decoder by it. */
  name: string;
  /** Where the part is: relative to the source's root when it has one, and
   * otherwise stored the way a file source's path is. */
  path: string;
  /** The part's size at the save. */
  bytes: number;
  /** Which version of the part was read, where the store can say. ""
   * otherwise. */
  version: string;
  /** How many bytes at the start of the part the join leaves out: a later
   * part's repeat of the header. 0 for a part read whole. */
  skip: number;
  /** Whether the part's last line is unterminated. The join adds a newline. */
  unterminated: boolean;
}

/**
 * JoinedAs is how a parts source's files are laid end to end, and where they
 * were found. Files picked by hand and joined as bytes record none of it.
 */
interface JoinedAs {
  /** 'rows' when each part is read on its own and its rows are laid after
   * the last part's. Absent when the parts' bytes are joined. */
  join?: PartsJoin;
  /**
   * The folder or bucket prefix the parts were found under, such as
   * s3://lake/orders/. Every part is under it, and its path is stored
   * relative to it. The root itself is stored the way a file source's path
   * is, and held absolute.
   */
  root?: string;
  /** The Hive keys in each part's path under the root, such as year and
   * month, in path order. */
  partitions?: string[];
}

/**
 * ReadAlone is what a part read on its own in row space records of itself.
 */
interface ReadAlone {
  /** What the part's bytes are compressed with. Absent for a plain part. */
  compression?: SourceCompression;
  /** How many rows the part held, once a pass has counted them. */
  rows?: number;
}

/**
 * ReadAs is how a source's rows were read, as a source records it. Delimited
 * text read as it always was records none of it.
 */
interface ReadAs {
  /** How the rows sit in the bytes. Absent for delimited text. */
  kind?: SourceKind;
  /**
   * What a file's bytes are compressed with. Absent for a plain file, and
   * for a source of several files.
   */
  compression?: SourceCompression;
  /**
   * The data columns at the save, in grid order, for a source that learns
   * its columns from its rows. A reopen gives each key back its column.
   */
  columns?: SavedColumn[];
}

/**
 * SavedColumn is one data column as uno.json pins it: the name the grid
 * shows, and the key its cells are found by in each row, an RFC 6901
 * pointer. The name never changes once given, so the key always finds the
 * column its logged edits were made in.
 */
export interface SavedColumn {
  name: string;
  /** Left out when it is the pointer of a top-level field called `name`. */
  key?: string;
}

/** Where the state entry is. */
export interface SheetRef {
  entry: string;
}

export interface EditsRef {
  count: number;
  entry: string;
}

/** Manifest is uno.json: the format, the sources, and where the other
 * entries are. */
export interface Manifest {
  format: number;
  generator: string;
  created: Date | undefined;
  modified: Date | undefined;
  sources: Source[];
  sheet: SheetRef;
  edits: EditsRef;
}

/** A position in the grid. */
export interface Cell {
  row: number;
  col: number;
}

/**
 * ColumnFormula points a bound column at the library file (.unof) it was
 * written in. A ref whose file has gone is fine: the column still computes
 * from the expression in the log.
 */
export interface ColumnFormula {
  col: number;
  ref: string;
}

/**
 * State is what one source's grid looked like: the active cell and, for each
 * bound column, which library file it came from. Everything else is replayed
 * from the log.
 */
export interface State {
  active: Cell;

  /**
   * Which .unof in the person's library each bound column came from. The
   * expression itself is in the log; this only lets "edit" find the file
   * again.
   */
  columnFormulas?: ColumnFormula[];
}

/**
 * Held is one source as a workspace holds it in memory: where its bytes are,
 * and what its grid looked like. `parts` is set only for several files read
 * as one.
 */
export type Held = HeldFile | HeldParts;

/** The fields a workspace holds for every source. */
interface HeldBase {
  id: string;
  name: string;
  /** The connection it was read through, for a pointed-at source. */
  connection?: string;
  rows: number;
  cols: number;
  state: State;
}

/**
 * HeldFile is a source that is one file. Exactly one of `raw` and `path` is
 * set: `raw` means the save copies the file in, `path` means it points at it.
 */
export interface HeldFile extends HeldBase, ReadAs {
  /** The file's bytes, for a carried source. */
  raw?: Uint8Array;
  /** Where the file is, absolute, for a pointed-at source. */
  path?: string;
  /** The file's size, for a pointed-at source. Taken from `raw` for a
   * carried one. */
  bytes?: number;
  /** Which version of the file the log was made against, for a pointed-at
   * source whose store can say. */
  version?: string;

  parts?: never;
  header?: never;
  fileColumn?: never;
  join?: never;
  root?: never;
  partitions?: never;
}

/**
 * HeldParts is a source that is several files read as one. Every part is
 * pointed at, so a save writes only its path.
 */
export interface HeldParts extends HeldBase, ReadAs, JoinedAs {
  /** The files, in the order their rows are read. At least one. */
  parts: HeldPart[];
  /** Whether the parts have a header row. Saved for delimited text only. */
  header: HeaderMode;
  /** Whether a `_file` column shows which part each row came from. */
  fileColumn?: boolean;

  raw?: never;
  path?: never;
  bytes?: never;
  version?: never;
  compression?: never;
}

/** HeldPart is one file of a HeldParts source. */
export interface HeldPart extends ReadAlone {
  /** The part's name. `ingest` picks a decoder by it. */
  name: string;
  /** Where the part is, absolute, and under the source's root when it has
   * one. */
  path: string;
  /** The part's size. */
  bytes: number;
  /** Which version of the part the log was made against, where the store
   * can say. */
  version?: string;
  /** How many bytes at the start of the part the join leaves out. 0 for a
   * part read in row space. */
  skip: number;
  /** Whether the part's last line is unterminated. False for a part read in
   * row space. */
  unterminated: boolean;
}

/**
 * Logged is one line of the log: an edit and the id of the source it changed.
 * The log is one list for the whole workspace, in the order the edits were
 * made. Each edit's `seq` is its place in its own source's log.
 */
export interface Logged {
  source: string;
  edit: Edit;
}

/**
 * Document is one .uno in memory.
 *
 * `writeDocument` reads manifest, sources, active, log, at and extra.
 * `sheets` is set only by `readDocument` and ignored by the writer.
 */
export interface Document {
  /**
   * The writer fills in every field here from what it writes, except
   * `created`, which the caller owns.
   */
  manifest: Manifest;
  /** At least one, in the order the workspace shows them. */
  sources: Held[];
  /** The id of the source that was showing. */
  active: string;
  log: Logged[];

  /**
   * Where the .uno itself is, so a source under the same folder is stored
   * relative to it. "" when unknown, such as a browser download; every
   * pointer is then stored absolute. `readContainer` resolves relative
   * pointers from the same path.
   */
  at: string;

  /**
   * Entries beyond what this build knows, carried through to the next save
   * intact.
   */
  extra: Map<string, Uint8Array>;

  /** Each source replayed, by id. Set by `readDocument` and ignored by the writer. */
  sheets?: Map<string, Sheet>;
}

/**
 * sourceEntry names a source's zip entry after the file it holds, so a
 * workspace opened from a TSV writes data/source.tsv. With `id` the entry is
 * data/source/<id>.<ext>, and otherwise data/source.<ext>. A compressed file
 * keeps every extension, as data/source/sales.csv.gz, and an extensionless
 * name gets .csv.
 */
export function sourceEntry(name: string, id?: string): string {
  const ext = nameParts(name).suffix.toLowerCase();
  return (
    (id === undefined ? SOURCE_STEM : SOURCE_DIR + id) +
    (ext === '' ? '.csv' : ext)
  );
}

/** The workspace file extension without its dot, as a dialog's filter names it. */
export const WORKSPACE_FILTER = 'uno';

/** The workspace file extension. The engine recognises a workspace by it. */
export const WORKSPACE_EXT = `.${WORKSPACE_FILTER}`;

/**
 * isWorkspace says whether a ref names a .uno. Several files read as one are
 * a source, whatever they are called.
 */
export function isWorkspace(ref: FileRef): boolean {
  return !('parts' in ref) && ref.name.toLowerCase().endsWith(WORKSPACE_EXT);
}

/** The characters an id keeps. Anything else becomes a dash. */
const ID_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * sourceId names a source after its file, as the log calls it: google-ads
 * for Google Ads.csv, and sales for sales.csv.gz. A folder is named after
 * itself. A name already in `taken` gets a numeric suffix: google-ads_2, then
 * _3, and so on.
 */
export function sourceId(name: string, taken: Iterable<string>): string {
  const stem = nameParts(name)
    .stem.replace(ID_UNSAFE, '-')
    .replace(/^[-.]+|-+$/g, '')
    .toLowerCase();
  const base = stem === '' ? 'source' : stem;

  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!used.has(id)) return id;
  }
}

/** logOf returns one source's edits, in order. */
export function logOf(log: readonly Logged[], id: string): Edit[] {
  return log.filter((l) => l.source === id).map((l) => l.edit);
}

/** newManifest returns an empty manifest, for a workspace yet to be saved. */
export function newManifest(): Manifest {
  return {
    format: 0,
    generator: '',
    created: undefined,
    modified: undefined,
    sources: [],
    sheet: { entry: '' },
    edits: { count: 0, entry: '' },
  };
}

/**
 * storedPath returns what the manifest writes for a source at `file` when
 * the .uno is saved to `at`: relative when the file is under the .uno's
 * folder, absolute otherwise.
 */
export function storedPath(file: string, at: string): string {
  return relativeTo(file, dirOf(at)) || file;
}

/** resolvedPath resolves a stored path from the .uno at `at`. */
export function resolvedPath(stored: string, at: string): string {
  return against(stored, dirOf(at));
}
