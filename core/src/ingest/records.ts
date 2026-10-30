/**
 * @fileoverview RecordFormat is how the engine reads a file of records: where
 * the first starts, a scanner that finds the first byte of each one, and a
 * decode of whole records into rows.
 *
 * delimitedRecords reads delimited text through its Format, which stays as
 * it is.
 */

import type { Said } from '@said';
import { labelOf } from './format.ts';
import type { Format, Scanner } from './format.ts';

/** Column is one data column of a source, as its header names it. */
export interface Column {
  /** What the header shows and formulas name. Unique in its source. */
  readonly name: string;
  /**
   * The RFC 6901 pointer to its values in a record. Absent for delimited
   * text, whose columns are found by their place.
   */
  readonly key?: string;
}

/** RecordFormat reads a file whose rows are records one after another. */
export interface RecordFormat {
  /** Where the first data record starts. */
  readonly dataStart: number;
  /** The data columns, in the order their cells come in a row. */
  columns(): readonly Column[];
  /**
   * A scanner that reports the first byte of every record it is fed and
   * learns nothing from them.
   */
  scanner(begin: (offset: number) => void): Scanner;
  /** The scanner the index pass feeds. Delimited text's is its scanner. */
  indexer(begin: (offset: number) => void): Scanner;
  /** One row per record the scanner reports in `bytes`. */
  decode(bytes: Uint8Array): string[][];
  /** How the file was read, for the status bar. */
  label(): Said;
}

/** delimitedRecords reads delimited text through its Format. */
export function delimitedRecords(format: Format): RecordFormat {
  const columns = format.columns.map((name): Column => ({ name }));
  return {
    dataStart: format.dataStart,
    columns: () => columns,
    scanner: (begin) => format.scanner(begin),
    indexer: (begin) => format.scanner(begin),
    decode: (bytes) => format.decode(bytes),
    label: () => labelOf(format),
  };
}
