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
export { Refusal, english, saidOf } from "../said/index.ts";
export type { CharName, Said, Sought, StepSaid } from "../said/index.ts";
export { formatBytes, messageOf, messagePort } from "./protocol.ts";
export type {
  Changed,
  ColumnInfo,
  EditRequest,
  FindRequest,
  Found,
  MessagePortLike,
  Link,
  Loaded,
  Offer,
  Opened,
  Opening,
  PartInfo,
  Peeked,
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
export type { Connecting } from "./serve.ts";
export {
  BYTES,
  DURATION_BOUNDS,
  ENDPOINT_VARIABLE,
  HEADERS_VARIABLE,
  INDEX,
  INDEXED,
  METRICS_PATH,
  MILLISECONDS,
  Meter,
  REQUEST,
  collector,
  otlpHeaders,
  unmeasured,
} from "./telemetry.ts";
export type {
  Attributes,
  Collector,
  Kind,
  Measurement,
  Payload,
  Resource,
  Telemetry,
} from "./telemetry.ts";
export { FILE_COLUMN } from "./view.ts";
export { FRAME_LIMIT, decode, encode, frameBytes, socketPort } from "./wire.ts";
export type { Frame, WebSocketLike } from "./wire.ts";
export { WHOLE_LIMIT } from "./workspace.ts";
