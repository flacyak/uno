// Package sheet holds one in-memory table per workspace. It imports nothing
// from the packages above it, which is what lets it be tested with no display
// attached.

export { ERR_CELL, Sheet, formatValue } from "./sheet.ts";
export type { Column } from "./sheet.ts";
export { NO_ROW, Op, editEquals } from "./edit.ts";
export type { Edit } from "./edit.ts";
export { SAMPLE_ROWS, inferKind, isDate } from "./kind.ts";
export type { Inferred, Kind } from "./kind.ts";
