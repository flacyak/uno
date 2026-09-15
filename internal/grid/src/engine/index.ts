// Package engine opens a file without loading it, and changes it without
// rewriting it.
//
// A worker owns the file and the log over it. It indexes the file a chunk at a
// time and serves rows by position with the log applied, so an edit anywhere is
// one line and the rows on screen. A client holds a band of rows around the
// viewport and nothing more, so what it costs depends on the screen and not on
// the file.

export { Band, Engine } from "./client.ts";
export type { Pending, RowsReply } from "./client.ts";
export { indexPass } from "./pass.ts";
export type { PassContext } from "./pass.ts";
export { formatBytes, messageOf, messagePort } from "./protocol.ts";
export type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  MessagePortLike,
  Offer,
  Opened,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
export { Pages, RowIndex, TUNING } from "./rows.ts";
export type { Tuning } from "./rows.ts";
export { serve } from "./serve.ts";
export { WHOLE_LIMIT } from "./view.ts";
export type { OpenSource } from "./view.ts";
