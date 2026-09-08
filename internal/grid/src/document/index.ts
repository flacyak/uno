// Package document reads and writes the .uno container.

export {
  BASE_VERSION,
  FORMAT_VERSION,
  FORMULA_VERSION,
  GENERATOR,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  SOURCES_VERSION,
  STATE_ENTRY,
  logOf,
  newManifest,
  sourceEntry,
  sourceId,
} from "./document.ts";
export type {
  Cell,
  ColumnFormula,
  Document,
  EditsRef,
  Embedded,
  Logged,
  Manifest,
  SheetRef,
  Source,
  State,
} from "./document.ts";
export { formatFor, readContainer, readDocument, versionFor, writeDocument } from "./codec.ts";
