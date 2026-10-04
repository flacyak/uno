// The messages between a client and an engine.
//
// An engine is a worker that owns one workspace. A client names files, asks
// for rows by position, and sends edits. Replies are ready to draw. Text for
// a person is sent as a `Said`, which the client renders in its own language.
// Every message is plain data, so it works over an Electron MessagePortMain,
// a Web Worker, or a MessageChannel.

import type { AuthMode, Connection } from "../library/index.ts";
import type { Change } from "../pattern/index.ts";
import type { Said } from "../said/index.ts";
import type { Edit, Kind, Op } from "../sheet/index.ts";
import type { Entry, FileRef, Listing, SingleRef } from "../store/index.ts";
import type { Tried, Unconnected } from "../store/s3.ts";

/**
 * SourceRef says where a source's bytes are: one file, or several read as
 * one. The engine opens it through whichever FileHandler claims it.
 */
export type SourceRef = FileRef;

export interface ColumnInfo {
  header: string;
  kind: Kind;
  flagged: boolean;
  /** The formula expression bound to the column, if any. */
  binding?: string;
}

/** How far the index has got. */
export interface Progress {
  /** Bytes scanned, out of the file's size. */
  done: number;
  total: number;
  /** Rows that can be requested now. */
  readable: number;
  /** Rows in the file: exact once complete, estimated until then. */
  rows: number;
  complete: boolean;
}

/**
 * Link is the file a source points at, and what is wrong with it.
 *
 * A source over one file has a link. It is absent on a carried source and
 * on an open source over several files. A source reopened from a .uno that
 * failed to read has a link with an empty path and `missing` set.
 */
export interface Link {
  /** Where the file is, as this machine names it. */
  path: string;

  /**
   * Which version of the file was opened, where the store can say: an S3
   * VersionId, or an ETag in quotes. Saved so the next open can detect a
   * rewrite.
   */
  version?: string;

  /**
   * Why this source is absent: its file is missing, or failed to open. The
   * source keeps its id, edits and place in the log, and
   * `relink` gives it a file again.
   */
  missing?: Said;

  /**
   * The file is there but its size or version differs from when the
   * workspace was saved. The edits still replay; this is a warning only.
   */
  changed?: Said;

  /**
   * The uncovered bucket this source reads, when that is why it is missing.
   * The panel offers to connect it.
   */
  connect?: Unconnected;
}

export interface Opened {
  /** The source's id in the workspace and its log. */
  source: string;
  /** The file name. For a .uno, the name of the source it carries. */
  name: string;
  size: number;
  /** How the bytes were read, for the status bar. Set on a source with rows behind it. */
  label?: Said;
  columns: ColumnInfo[];
  progress: Progress;
  /** This source's edits from the .uno it was opened from, already applied.
   * Empty otherwise. */
  edits: Edit[];
  generation: number;
  /** The file this source points at, if any. */
  link?: Link;
  /**
   * The files a source over several files reads, in the order their rows are
   * read.
   */
  parts?: PartInfo[];
}

/** One file of a source that reads several as one. */
export interface PartInfo {
  name: string;
  /** Where the file is, or "" for a dropped file. */
  path: string;
}

/** What an open added to the workspace, in display order. */
export interface Opening {
  opened: Opened[];
  /** The source to show: the one just added, or the one a .uno was left on. */
  showing: string;
}

/** An edit as a client sends it. The engine numbers it and fills in `was`. */
export interface EditRequest {
  op: Op;
  row: number;
  col: number;
  now: string;
}

/** The result of an edit, undo or redo: the edit, and the columns after it. */
export interface Changed {
  edit: Edit;
  /** Rows built before this number are stale. */
  generation: number;
  columns: ColumnInfo[];
}

/** The cursor position of each source and which source was showing. Written by a save. */
export interface Place {
  /** The source that was showing. */
  source: string;
  cells: Array<{ source: string; row: number; col: number }>;

  /**
   * The path the .uno is saved to. A source under the same folder is pointed
   * at relative to it. Empty for a caller that has yet to choose a path, in
   * which case every pointer is absolute.
   */
  at: string;
}

/** A find: the next row down or up one column whose cell matches. */
export interface FindRequest {
  col: number;
  /** The row the search starts beside. Matching starts at the next row. */
  from: number;
  /** 1 looks down, -1 up. */
  dir: 1 | -1;
  /** Match a cell that fails to parse as its column's kind, or one whose text contains `text`. */
  match: { t: "unparsed" } | { t: "text"; text: string };
}

export interface Found {
  /** The matching row, or null for none. */
  row: number | null;
  /** Rows looked at. */
  searched: number;
  /**
   * Whether the search reached the end of the file in its direction. A
   * downward search stops at the readable limit of the index.
   */
  complete: boolean;
}

/**
 * Offer is the recogniser's current proposal for a column.
 *
 * It is sent more than once for a large file. Until `complete`, `affects`
 * counts the cells changed in the first `scanned` rows.
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
 * Peeked is a preview of a file: its header and first rows, read from the
 * front of the file apart from the workspace.
 */
export interface Peeked {
  /** How the bytes were read, for example "UTF-8 · delimiter ','". */
  label: Said;
  /** The header row, one string per column. */
  header: string[];
  /** The rows under the header, up to the peek's row limit. */
  rows: string[][];
}

/**
 * Loaded is what an engine read from its connections folder: every
 * connection, and a message for each file that failed to read.
 */
export interface Loaded {
  connections: Connection[];
  failed: Said[];
}

/**
 * SignIns lists the ways this engine can sign in to a bucket. Only names and
 * ARNs cross the port; credentials stay on the engine's machine.
 */
export interface SignIns {
  /** The sign-in modes, in the order to offer them. */
  modes: AuthMode[];
  /** The names of the AWS profiles on this engine's machine. Filled when `profile` is a mode. */
  profiles: string[];
  /**
   * What a role's trust policy must name, when `role` is a mode: the
   * engine's principal and the external ID for the asking account.
   */
  trust?: Trust;
}

/** Trust is what a role's trust policy must name for the hosted engine to assume it. */
export interface Trust {
  /** The ARN the policy lets assume the role: the engine's own. */
  principal: string;
  /** The external ID the policy's condition asks for. */
  externalId: string;
}

/**
 * The most rows one `rows` request may ask for. A larger request is refused
 * at the port.
 */
export const ROWS_AT_MOST = 2000;

export type Request =
  /**
   * Add a file to the workspace: read its header and begin indexing. A .uno
   * opens every source it holds, and only into an empty workspace.
   */
  | { t: "open"; id: number; ref: SourceRef }
  /** Remove a source from the workspace, and its edits from the log. */
  | { t: "remove"; id: number; source: string }
  /**
   * Point a source at a different file. The source keeps its id, edits and
   * place in the log. The log is replayed over the new file.
   */
  | { t: "relink"; id: number; source: string; ref: SourceRef }
  /**
   * Add files at the end of a source that reads several files as one. Every
   * existing row keeps its number, so the log is unchanged.
   */
  | { t: "append"; id: number; source: string; parts: SingleRef[] }
  /** Rows by position, with the log applied. Fewer where the index stops short. */
  | { t: "rows"; id: number; source: string; first: number; count: number }
  | { t: "edit"; id: number; source: string; edit: EditRequest }
  /** Take back the source's last edit. */
  | { t: "undo"; id: number; source: string }
  /** Record again the edit that undo last took back. */
  | { t: "redo"; id: number; source: string }
  /** The next matching row in a column, searched in the file. */
  | { t: "find"; id: number; source: string; find: FindRequest }
  /** One page of a folder or prefix listing. Names a path, since it runs ahead of any source. */
  | { t: "list"; id: number; path: string; cursor?: string }
  /** Size and version of a path, from its metadata alone. */
  | { t: "stat"; id: number; path: string }
  /**
   * A preview of a file, read apart from the workspace. Names a ref, which
   * covers a dropped file as well as a path.
   */
  | { t: "peek"; id: number; ref: SourceRef }
  /** Reload the connections this engine signs in through and return them. */
  | { t: "connections"; id: number }
  /** How this engine signs in to a bucket. */
  | { t: "signins"; id: number }
  /**
   * Try a connection before it is saved: find its bucket's region and list a
   * page of its prefix. The connection is dropped afterwards.
   */
  | { t: "try"; id: number; connection: Connection }
  /** Transform allows edits and runs the recogniser over every source. View is read-only. */
  | { t: "mode"; transform: boolean }
  /** Write the workspace as a .uno. Refused if carried sources total more than limit bytes. */
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
      /** What each cell stores, or null for a row where that matches what it shows. */
      raws: Array<string[] | null>;
    }
  | { t: "changed"; id: number; source: string; changed: Changed }
  | { t: "found"; id: number; found: Found }
  | { t: "listed"; id: number; listing: Listing }
  | { t: "statted"; id: number; entry: Entry }
  | { t: "peeked"; id: number; peeked: Peeked }
  /** The connections read, and a message for each file that failed to read. */
  | { t: "loaded"; id: number; loaded: Loaded }
  /** The sign-in modes, profile names and role trust on offer. */
  | { t: "offered"; id: number; signins: SignIns }
  | { t: "tried"; id: number; tried: Tried }
  /** Null when the recogniser finishes with an empty proposal. */
  | { t: "offer"; source: string; generation: number; offer: Offer | null }
  | { t: "saved"; id: number; bytes: Uint8Array }
  /** Unnumbered, a failure of an index or a pass behind a source. */
  | { t: "error"; id?: number; source?: string; said: Said };

/** One end of a connection. */
export interface Port<In, Out> {
  post(msg: Out): void;
  /**
   * listen hands every message to `fn`. It calls `gone` once when the far
   * end closes first. A close from this side ends listening in silence.
   */
  listen(fn: (msg: In) => void, gone?: () => void): void;
  close(): void;
}

/** The part of a web MessagePort this uses. Node's MessagePort has it too. */
export interface MessagePortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  /** Fired once either end has closed. */
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
