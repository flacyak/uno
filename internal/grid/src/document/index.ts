// Package document reads and writes the .uno container.

export {
  BASE_VERSION,
  FORMAT_VERSION,
  GENERATOR,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  STATE_ENTRY,
  newManifest,
  sourceEntry,
} from "./document.ts";
export type {
  Cell,
  ColumnFormula,
  Document,
  EditsRef,
  Manifest,
  SheetRef,
  Source,
  State,
} from "./document.ts";
export { readDocument, versionFor, writeDocument } from "./codec.ts";
