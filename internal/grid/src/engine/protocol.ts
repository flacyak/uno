// The messages between a client and an engine.
//
// An engine is a worker that owns one workspace: its sources, and the log over
// them. Its client -- a renderer, or a test -- never touches the bytes: it names
// each file once, asks one source for rows by position, and sends it edits. What
// comes back is ready to draw.
// Everything crosses as plain data, so the same messages run over an Electron
// MessagePortMain, a Web Worker or a MessageChannel in vitest.

import type { Change } from "../pattern/index.ts";
import type { Edit, Kind, Op } from "../sheet/index.ts";

/**
 * SourceRef says where a file is without holding any of it.
 *
 * A path means something only to a desktop engine and a Blob only to a browser
 * one. Each platform's worker entry opens the kind it understands and refuses
 * the other.
 */
export type SourceRef = { name: string; path: string } | { name: string; blob: Blob };

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
 * `changed` set while everything is as it was.
 */
export interface Link {
  /** Where the file is, as this machine names it. */
  path: string;

  /**
   * Why there is no grid behind this source: the file was not where the
   * workspace said, or would not open. The source is still here -- its id, its
   * edits and its place in the log are kept -- and `relink` gives it a file
   * again.
   */
  missing?: string;

  /**
   * The file is there and is a different size than when the workspace was
   * saved, so the log may be naming rows in data that has moved under it.
   *
   * It is said and not acted on. The edits still replay, because refusing to
   * open a workspace over an appended row would be a worse answer than showing
   * it and saying so.
   */
  changed?: string;
}

export interface Opened {
  /** What the workspace and its log call this source. */
  source: string;
  /** The file the rows come from. A .uno names the source it carries. */
  name: string;
  size: number;
  /** How the bytes were read, for the status bar. */
  label: string;
  columns: ColumnInfo[];
  progress: Progress;
  /** This source's part of the log a .uno was saved with, already applied.
   * Empty for anything else. */
  edits: Edit[];
  generation: number;
  /** The file this source points at, for one that does. */
  link?: Link;
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
  description: string;
  affects: number;
  sample: Change[];
  ambiguous: boolean;
  scanned: number;
  rows: number;
  complete: boolean;
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
  /** Rows by position, with the log applied. Fewer where the index has not reached. */
  | { t: "rows"; id: number; source: string; first: number; count: number }
  | { t: "edit"; id: number; source: string; edit: EditRequest }
  /** The source's last edit, taken back. */
  | { t: "undo"; id: number; source: string }
  /** The edit undo last took back from the source, recorded again. */
  | { t: "redo"; id: number; source: string }
  /** The next matching row in a column, read from the file rather than any band. */
  | { t: "find"; id: number; source: string; find: FindRequest }
  /** Transform allows edits and runs the recogniser, over every source. View allows neither. */
  | { t: "mode"; transform: boolean }
  /** The workspace as a .uno, refusing carried sources larger than limit together. */
  | { t: "save"; id: number; place: Place; limit: number }
  | { t: "close" };

export type Reply =
  | { t: "opened"; id: number; added: Opening }
  | { t: "removed"; id: number }
  | { t: "relinked"; id: number; opened: Opened }
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
  /** Null when the source has nothing to ask. */
  | { t: "offer"; source: string; generation: number; offer: Offer | null }
  | { t: "saved"; id: number; bytes: Uint8Array }
  /** Without an id, a failure of an index or a pass behind a source. */
  | { t: "error"; id?: number; source?: string; message: string };

/** One end of a connection, whatever the runtime calls it. */
export interface Port<In, Out> {
  post(msg: Out): void;
  listen(fn: (msg: In) => void): void;
  close(): void;
}

/** The part of a web MessagePort this uses. Node's MessagePort has it too. */
export interface MessagePortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export function messagePort<In, Out>(p: MessagePortLike): Port<In, Out> {
  return {
    post: (msg) => p.postMessage(msg),
    listen: (fn) => {
      p.addEventListener("message", (e) => fn(e.data as In));
      p.start();
    },
    close: () => p.close(),
  };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
