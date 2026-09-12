// The messages between a client and an engine.
//
// An engine is a worker that owns one file and the log over it. Its client -- a
// renderer, or a test -- never touches the bytes: it names the file once, asks
// for rows by position, and sends edits. What comes back is ready to draw.
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

export interface Opened {
  /** The file the rows come from. A .uno names the source it carries. */
  name: string;
  size: number;
  /** How the bytes were read, for the status bar. */
  label: string;
  columns: ColumnInfo[];
  progress: Progress;
  /** The log a .uno was saved with, already applied. Empty for anything else. */
  edits: Edit[];
  generation: number;
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

/**
 * Offer is the recogniser's question as it stands.
 *
 * It arrives more than once for a large file. Until `complete`, `affects` counts
 * the cells changed in the first `scanned` rows, which makes it a lower bound a
 * banner can say out loud.
 */
export interface Offer {
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
  /** Start viewing a file: read its header, begin indexing it. */
  | { t: "open"; ref: SourceRef }
  /** Rows by position, with the log applied. Fewer where the index has not reached. */
  | { t: "rows"; id: number; first: number; count: number }
  | { t: "edit"; id: number; edit: EditRequest }
  | { t: "undo"; id: number }
  /** Transform allows edits and runs the recogniser. View allows neither. */
  | { t: "mode"; transform: boolean }
  /** The workspace as a .uno, refusing a source larger than limit. */
  | { t: "save"; id: number; active: { row: number; col: number }; limit: number }
  | { t: "close" };

export type Reply =
  | { t: "opened"; opened: Opened }
  | { t: "progress"; progress: Progress }
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
  | { t: "changed"; id: number; changed: Changed }
  /** Null when there is nothing to ask. */
  | { t: "offer"; generation: number; offer: Offer | null }
  | { t: "saved"; id: number; bytes: Uint8Array }
  /** Without an id, a failure of the open or of a pass behind it. */
  | { t: "error"; id?: number; message: string };

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
