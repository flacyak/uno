// The messages between a client and an engine.
//
// An engine is a worker that owns one workspace: its sources, and the log over
// them. Its client -- a renderer, or a test -- never touches the bytes: it names
// each file once, asks one source for rows by position, and sends it edits. What
// comes back is ready to draw. What it says to a person comes back as data, a
// `Said`, for the client to write in the person's language.
// Everything crosses as plain data, so the same messages run over an Electron
// MessagePortMain, a Web Worker or a MessageChannel in vitest.

import type { Connection } from "../library/index.ts";
import type { Change } from "../pattern/index.ts";
import type { Said } from "../said/index.ts";
import type { Edit, Kind, Op } from "../sheet/index.ts";
import type { Entry, FileRef, Listing, SingleRef } from "../store/index.ts";
import type { Tried, Unconnected } from "../store/s3.ts";

/**
 * SourceRef says where a source's bytes are without holding any of them: a
 * FileRef, one file or several read as one, which the engine opens through
 * whichever of its FileHandlers claims it.
 */
export type SourceRef = FileRef;

export interface ColumnInfo {
  header: string;
  kind: Kind;
  flagged: boolean;
  /** The expression a formula computes the column from, when one does. */
  binding?: string;
}

/** How far the index has got, and what a client may ask for because of it. */
export interface Progress {
  /** Bytes scanned, out of the file's size. */
  done: number;
  total: number;
  /** Rows a request can be answered for now. */
  readable: number;
  /** Rows in the file: exact once complete, projected from the bytes scanned until then. */
  rows: number;
  complete: boolean;
}

/**
 * Link is the file a source points at, and what is wrong with it.
 *
 * A source the workspace carries has no link at all: there is no file to be
 * wrong about. One that points at a file has a link with neither `missing` nor
 * `changed` set while everything is as it was. Several files read as one have
 * no link either while they are open, since a link is one path, so nothing is
 * asked or said about their files changing. Reopened from a .uno and not
 * readable, they have one with an empty path, which says why in `missing`.
 */
export interface Link {
  /** Where the file is, as this machine names it. */
  path: string;

  /**
   * Which bytes of it were opened, where the place can say: an S3 VersionId,
   * or an ETag in its quotes. A save writes it down, so the next open can tell
   * a rewrite from the file the log was made against.
   */
  version?: string;

  /**
   * Why there is no grid behind this source: the file was not where the
   * workspace said, or would not open. The source is still here -- its id, its
   * edits and its place in the log are kept -- and `relink` gives it a file
   * again.
   */
  missing?: Said;

  /**
   * The file is there and is a different size than when the workspace was
   * saved, so the log may be naming rows in data that has moved under it.
   *
   * It is said and not acted on. The edits still replay, because refusing to
   * open a workspace over an appended row would be a worse answer than showing
   * it and saying so.
   */
  changed?: Said;

  /**
   * The bucket a source reads that no connection covers, when that is why it
   * is missing: a .uno somebody sent names a bucket, and nothing was read
   * from it, because this machine has not made or accepted a connection to it.
   * The panel offers to connect it with the bucket filled in.
   */
  connect?: Unconnected;
}

export interface Opened {
  /** What the workspace and its log call this source. */
  source: string;
  /** The file the rows come from. A .uno names the source it carries. */
  name: string;
  size: number;
  /** How the bytes were read, for the status bar. Nothing for a source with no file. */
  label?: Said;
  columns: ColumnInfo[];
  progress: Progress;
  /** This source's part of the log a .uno was saved with, already applied.
   * Empty for anything else. */
  edits: Edit[];
  generation: number;
  /** The file this source points at, for one that does. */
  link?: Link;
  /**
   * The files it reads as one, in the order their rows are read, for a source
   * that is several: what a client needs to say how many there are, and to
   * see that the folder they came from has more.
   */
  parts?: PartInfo[];
}

/** One of the files a source reads as one, as a client is told of it. */
export interface PartInfo {
  name: string;
  /** Where the file is, or "" for a dropped one, which has no path. */
  path: string;
}

/** What an open added to the workspace, in the order it shows them. */
export interface Opening {
  opened: Opened[];
  /** The source to show: the one just added, or the one a .uno was left on. */
  showing: string;
}

/** An edit as a client asks for it. The engine numbers it and fills in `was`. */
export interface EditRequest {
  op: Op;
  row: number;
  col: number;
  now: string;
}

/** What an edit or an undo leaves behind: the edit, and the columns after it. */
export interface Changed {
  edit: Edit;
  /** Rows built before this number are stale. */
  generation: number;
  columns: ColumnInfo[];
}

/** Where each source's grid was left, and which source was showing: what a save keeps. */
export interface Place {
  /** The source that was showing. */
  source: string;
  cells: Array<{ source: string; row: number; col: number }>;

  /**
   * Where the .uno is going, so a source under the same folder is pointed at
   * relative to it. Empty where the caller has no path to give, and every
   * pointer is then absolute.
   */
  at: string;
}

/** A find: the next row down or up one column whose cell matches. */
export interface FindRequest {
  col: number;
  /** The row the search starts beside. It is never a match itself. */
  from: number;
  /** 1 looks down, -1 up. */
  dir: 1 | -1;
  /** A cell that does not parse as its column's kind, or one that shows some text. */
  match: { t: "unparsed" } | { t: "text"; text: string };
}

export interface Found {
  /** The matching row, or null for none. */
  row: number | null;
  /** Rows looked at. */
  searched: number;
  /**
   * Whether the search reached the end of the file in its direction. Down, it
   * stops where the index has got to rather than waiting for the rest.
   */
  complete: boolean;
}

/**
 * Offer is the recogniser's question as it stands.
 *
 * It arrives more than once for a large file. Until `complete`, `affects` counts
 * the cells changed in the first `scanned` rows, which makes it a lower bound a
 * banner can say out loud.
 */
export interface Offer {
  /** The source whose column it is. */
  source: string;
  col: number;
  header: string;
  /** The program's text, which is what Apply records. */
  program: string;
  /** What the program does, in words. */
  description: Said;
  affects: number;
  sample: Change[];
  ambiguous: boolean;
  scanned: number;
  rows: number;
  complete: boolean;
}

/**
 * Peeked is what a file holds, before anything is added: enough of it to
 * decide by, and no more.
 *
 * It is the answer to a selection in the panel, so a 30 GB export and a 30 KB
 * one have to cost the same -- one HEAD and one ranged GET of the front of it
 * -- because a person clicking down a list of objects is asking the same
 * question of each and should not pay by the size of what they land on.
 */
export interface Peeked {
  /** How the bytes were read, the sentence an opened source carries too:
   * "UTF-8 · delimiter ','". */
  label: Said;
  /** The header row, one string per column. */
  header: string[];
  /** The rows under it, as many as the peek takes or the bytes it read held. */
  rows: string[][];
}

/**
 * Loaded is what an engine read out of its connections folder: every
 * connection it can sign in through, and a sentence for each file it could
 * not read, since one broken file costs one connection and still wants saying.
 */
export interface Loaded {
  connections: Connection[];
  failed: Said[];
}

export type Request =
  /**
   * Add a file to the workspace: read its header, begin indexing it. A .uno
   * opens every source it holds, and only into a workspace holding none.
   */
  | { t: "open"; id: number; ref: SourceRef }
  /** Take a source out of the workspace, and its edits out of the log. */
  | { t: "remove"; id: number; source: string }
  /**
   * Point a source at a file: the one whose file has gone, or one whose file
   * has changed under it. The source keeps its id, its edits and its place in
   * the log, and the log is replayed over what the file holds now.
   */
  | { t: "relink"; id: number; source: string; ref: SourceRef }
  /**
   * Add files at the end of a source that is several read as one. Its rows
   * extend, and every row it had keeps its number, so the log is untouched and
   * each edit stays on the cell it was made to.
   */
  | { t: "append"; id: number; source: string; parts: SingleRef[] }
  /** Rows by position, with the log applied. Fewer where the index has not reached. */
  | { t: "rows"; id: number; source: string; first: number; count: number }
  | { t: "edit"; id: number; source: string; edit: EditRequest }
  /** The source's last edit, taken back. */
  | { t: "undo"; id: number; source: string }
  /** The edit undo last took back from the source, recorded again. */
  | { t: "redo"; id: number; source: string }
  /** The next matching row in a column, read from the file rather than any band. */
  | { t: "find"; id: number; source: string; find: FindRequest }
  /**
   * One page of a folder or a prefix. It names a path and not a source,
   * because it is asked before there is one: a panel browsing its way toward
   * something to open.
   */
  | { t: "list"; id: number; path: string; cursor?: string }
  /** Size and version of a path now, without reading it: the same way, and for
   * the same reason. */
  | { t: "stat"; id: number; path: string }
  /**
   * What a file holds, without adding it to the workspace: a person picking
   * one out of a folder of four hundred wants to see it before they commit a
   * tab to it.
   *
   * It names a ref and not a path, because a file about to be added may have
   * no path: bytes dropped into a page are looked at the same way an object in
   * a bucket is.
   */
  | { t: "peek"; id: number; ref: SourceRef }
  /**
   * The connections this engine signs in through, read again from where they
   * are kept: asked once they have changed, so a connection saved a moment ago
   * is one the engine uses without being started again.
   */
  | { t: "connections"; id: number }
  /** The names of the AWS profiles the engine's machine has, for a person picking one. */
  | { t: "profiles"; id: number }
  /**
   * A connection tried before it is saved: where its bucket is, and a page of
   * its prefix, asked the way it signs in. Nothing is kept by asking.
   */
  | { t: "try"; id: number; connection: Connection }
  /** Transform allows edits and runs the recogniser, over every source. View allows neither. */
  | { t: "mode"; transform: boolean }
  /** The workspace as a .uno, refusing carried sources larger than limit together. */
  | { t: "save"; id: number; place: Place; limit: number }
  | { t: "close" };

export type Reply =
  | { t: "opened"; id: number; added: Opening }
  | { t: "removed"; id: number }
  | { t: "relinked"; id: number; opened: Opened }
  | { t: "appended"; id: number; opened: Opened }
  | { t: "progress"; source: string; progress: Progress }
  | {
      t: "rows";
      id: number;
      first: number;
      generation: number;
      /** What each cell shows. */
      rows: string[][];
      /** What each cell stores, where that differs from what it shows. */
      raws: Array<string[] | null>;
    }
  | { t: "changed"; id: number; source: string; changed: Changed }
  | { t: "found"; id: number; found: Found }
  | { t: "listed"; id: number; listing: Listing }
  | { t: "statted"; id: number; entry: Entry }
  | { t: "peeked"; id: number; peeked: Peeked }
  /** What a connections request read, and what it could not, one sentence a file. */
  | { t: "loaded"; id: number; loaded: Loaded }
  /** Profile names, and nothing else out of the files they are in. */
  | { t: "names"; id: number; names: string[] }
  | { t: "tried"; id: number; tried: Tried }
  /** Null when the source has nothing to ask. */
  | { t: "offer"; source: string; generation: number; offer: Offer | null }
  | { t: "saved"; id: number; bytes: Uint8Array }
  /** Without an id, a failure of an index or a pass behind a source. */
  | { t: "error"; id?: number; source?: string; said: Said };

/** One end of a connection, whatever the runtime calls it. */
export interface Port<In, Out> {
  post(msg: Out): void;
  /**
   * listen hands every message to `fn`, and tells `gone` once when the far end
   * has gone first -- the process behind it exited, or the socket closed --
   * so what was waiting on an answer is not left waiting for one that cannot
   * come. A port that closes itself tells nobody: it knew.
   */
  listen(fn: (msg: In) => void, gone?: () => void): void;
  close(): void;
}

/** The part of a web MessagePort this uses. Node's MessagePort has it too. */
export interface MessagePortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  /** Fired once either end has closed, which is when the other end went. */
  addEventListener(type: "close", fn: () => void): void;
  start(): void;
  close(): void;
}

export function messagePort<In, Out>(p: MessagePortLike): Port<In, Out> {
  return {
    post: (msg) => p.postMessage(msg),
    listen: (fn, gone) => {
      p.addEventListener("message", (e) => fn(e.data as In));
      if (gone !== undefined) p.addEventListener("close", gone);
      p.start();
    },
    close: () => p.close(),
  };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { formatBytes } from "../said/index.ts";
