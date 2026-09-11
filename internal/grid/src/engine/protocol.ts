// The messages between a client and an engine.
//
// An engine is a worker that owns one file. Its client -- a renderer, or a test
// -- never touches the bytes: it names the file once and asks for rows by
// position, and what comes back is ready to draw. Everything crosses as plain
// data, so the same messages run over an Electron MessagePortMain, a Web Worker
// or a MessageChannel in vitest.

import type { Kind } from "../sheet/index.ts";

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
  size: number;
  /** How the bytes were read, for the status bar. */
  label: string;
  columns: ColumnInfo[];
  progress: Progress;
}

export type Request =
  /** Start viewing a file: read its header, begin indexing it. */
  | { t: "open"; ref: SourceRef }
  /** Rows by position. The reply holds fewer where the index has not reached. */
  | { t: "rows"; id: number; first: number; count: number }
  /** A whole file, for the paths that still need one in memory. */
  | { t: "bytes"; id: number; ref: SourceRef; limit: number }
  | { t: "close" };

export type Reply =
  | { t: "opened"; opened: Opened }
  | { t: "progress"; progress: Progress }
  | { t: "rows"; id: number; first: number; rows: string[][] }
  | { t: "bytes"; id: number; bytes: Uint8Array }
  /** Without an id, a failure of the open or of the index behind it. */
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
