// Package engine opens files without loading them, and changes them without
// rewriting them.
//
// A worker owns a workspace: its sources, and the log over them. It indexes
// each file a chunk at a time and serves rows by position with the log
// applied, so an edit anywhere is one line and the rows on screen. A client
// holds a band of rows around the viewport and nothing more, so what it costs
// depends on the screen and not on the files.

export { Band, Engine, SourceHandle } from "./client.ts";
export type { Added, Pending, RowsReply } from "./client.ts";
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
  Link,
  Offer,
  Opened,
  Opening,
  Place,
  Port,
  Progress,
  Reply,
  Request,
  SourceRef,
} from "./protocol.ts";
export { Pages, RowIndex, TUNING } from "./rows.ts";
export type { Tuning } from "./rows.ts";
export { serve } from "./serve.ts";
export type { OpenSource } from "./view.ts";
export { WHOLE_LIMIT } from "./workspace.ts";
