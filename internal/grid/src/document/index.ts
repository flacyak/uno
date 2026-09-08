// Package document reads and writes the .uno container.

export {
  BASE_VERSION,
  FORMAT_VERSION,
  FORMULA_VERSION,
  GENERATOR,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  POINTED_VERSION,
  RULE_VERSION,
  SOURCES_VERSION,
  STATE_ENTRY,
  logOf,
  newManifest,
  resolvedPath,
  sourceEntry,
  sourceId,
  storedPath,
} from "./document.ts";
export type {
  Cell,
  ColumnFormula,
  Document,
  EditsRef,
  Held,
  Logged,
  Manifest,
  SheetRef,
  Source,
  State,
} from "./document.ts";
export { against, baseOf, dirOf, isAbsolute, relativeTo } from "./path.ts";
export { formatFor, readContainer, readDocument, versionFor, writeDocument } from "./codec.ts";
