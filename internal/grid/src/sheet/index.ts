// Package sheet holds one table per workspace. It imports nothing from the
// packages above it, which is what lets it be tested with no display attached.

export { Sheet } from "./sheet.ts";
export type { Column } from "./sheet.ts";
export { Schema } from "./schema.ts";
export type { Run, Written } from "./schema.ts";
export { ERR_CELL, finish, formatValue, settled, valueAt } from "./pipeline.ts";
export type { Finished } from "./pipeline.ts";
export { NO_ROW, Op, editEquals } from "./edit.ts";
export type { Edit } from "./edit.ts";
export { SAMPLE_ROWS, inferKind, isDate } from "./kind.ts";
export type { Inferred, Kind } from "./kind.ts";
