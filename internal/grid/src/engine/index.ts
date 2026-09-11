// Package engine opens a file without loading it.
//
// A worker owns the file, indexes it a chunk at a time, and serves rows by
// position. A client holds a band of rows around the viewport and nothing
// more, so what it costs depends on the screen and not on the file.

export { Band, Engine } from "./client.ts";
export { indexPass } from "./pass.ts";
export type { PassContext } from "./pass.ts";
export { messageOf, messagePort } from "./protocol.ts";
export type {
  ColumnInfo,
  MessagePortLike,
  Opened,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
export { Pages, RowIndex, TUNING } from "./rows.ts";
export type { Tuning } from "./rows.ts";
export { formatBytes, serve } from "./serve.ts";
export type { OpenSource } from "./serve.ts";
