/**
 * @fileoverview What the scanner variants share: the states of
 * core/src/ingest/scan.ts under the same numbers, the bytes they react to, and
 * the interface the property test and the benchmark drive every variant
 * through.
 *
 * A variant is equivalent to RecordScanner when, fed the same bytes in the
 * same chunks, it reports the same begins and ends every push in the same
 * state, with the same CR offset when that state is LINE_CR.
 */

export const LF = 0x0a;
export const CR = 0x0d;
export const QUOTE = 0x22;
/** Bytes at or above this are never a separator: they may be part of a
 * multi-byte character. */
const ASCII_END = 0x80;

/** Between records. A blank line here is skipped. */
export const LINE = 0;
/** Between records, after a CR. It is a blank line only if LF follows. */
export const LINE_CR = 1;
/** Inside a record, at the first byte of a field. */
export const FIELD = 2;
/** Inside an unquoted field, where a quote is data. */
export const BARE = 3;
/** Inside a quoted field. */
export const QUOTED = 4;
/** Inside a quoted field, just past a quote. */
export const QUOTE_SEEN = 5;
/** Inside a quoted field, past a quote and a CR. */
export const QUOTE_CR = 6;

/** State is where a scanner is between bytes. */
export type State =
  | typeof LINE
  | typeof LINE_CR
  | typeof FIELD
  | typeof BARE
  | typeof QUOTED
  | typeof QUOTE_SEEN
  | typeof QUOTE_CR;

/** The states in order of their numbers, to turn a number back into a State. */
export const STATES_BY_NUMBER: readonly State[] = [
  LINE,
  LINE_CR,
  FIELD,
  BARE,
  QUOTED,
  QUOTE_SEEN,
  QUOTE_CR,
];

/** Begin is told the file offset of each record's first byte, in order. */
export type Begin = (offset: number) => void;

/** A run of begins, held in a typed array a scanner reuses. */
export type Begins = Float64Array | Int32Array;

/**
 * Many is told a run of begins at once: the records start at
 * `base + begins[k]` for every k below `count`, in order. The array is
 * reused once Many returns.
 */
export type Many = (begins: Begins, count: number, base: number) => void;

/** Consumer is where a scanner reports begins: one at a time, or a run. */
export interface Consumer {
  readonly begin: Begin;
  readonly many: Many;
}

/** LabScanner is a Scanner whose state between pushes can be read. */
export interface LabScanner {
  push(chunk: Uint8Array, base: number): void;
  /** The state after the last byte pushed. */
  readonly state: State;
  /** The offset of the CR that put the scanner in LINE_CR. Read only then. */
  readonly crAt: number;
}

/**
 * separatorByte returns the byte of `comma`, refusing the same separators
 * RecordScanner refuses.
 */
export function separatorByte(comma: string): number {
  const sep = comma.charCodeAt(0);
  if (
    comma.length !== 1 ||
    sep >= ASCII_END ||
    sep === QUOTE ||
    sep === LF ||
    sep === CR
  ) {
    throw new Error(`${JSON.stringify(comma)} cannot separate fields`);
  }
  return sep;
}
