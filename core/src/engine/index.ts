/**
 * @fileoverview Package engine indexes files chunk by chunk and serves rows by
 * position with the edit log applied.
 *
 * A worker owns one workspace: its sources and the log over them. A client
 * holds a band of rows around the viewport and asks the worker for more.
 */

export { BAND_ROWS, Band, Engine, SourceHandle } from './client.ts';
export type { Added, Pending, RowsReply } from './client.ts';
export { unchanged } from './fresh.ts';
export { indexPass } from './pass.ts';
export type { PassContext } from './pass.ts';
export { Refusal, english, saidOf } from '@said';
export type { CharName, Said, Sought, StepSaid } from '@said';
export {
  GROUPS_SENT,
  LABEL_AT_MOST,
  ROWS_AT_MOST,
  SCATTER_POINTS_AT_MOST,
  formatBytes,
  messageOf,
  messagePort,
} from './protocol.ts';
export type {
  Changed,
  ColumnInfo,
  Coverage,
  EditRequest,
  FindRequest,
  Found,
  Group,
  Groups,
  GroupsTally,
  MessagePortLike,
  Link,
  Loaded,
  Offer,
  Opened,
  Opening,
  PartInfo,
  Peeked,
  Place,
  Point,
  Port,
  Progress,
  Reply,
  Request,
  Sample,
  SampleTally,
  SignIns,
  Skipped,
  SourceRef,
  Tally,
  Trust,
} from './protocol.ts';
export { Pages, RowIndex, TUNING } from './rows.ts';
export type { Tuning } from './rows.ts';
export { serve } from './serve.ts';
export type { Connecting } from './serve.ts';
export {
  BYTES,
  COLLECTOR_VARIABLES,
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
} from './telemetry.ts';
export type {
  Attributes,
  Collector,
  Kind,
  Measurement,
  Payload,
  Resource,
  Telemetry,
} from './telemetry.ts';
export { FILE_COLUMN } from './view.ts';
export { CLOSED, GONE, Session, socketPort } from './session.ts';
export type { WebSocketLike } from './session.ts';
export { FRAME_LIMIT, decode, encode, frameBytes } from './wire.ts';
export type { Carried, Frame } from './wire.ts';
export { WHOLE_LIMIT } from './workspace.ts';
