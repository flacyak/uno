/**
 * @fileoverview Variant (c): a table-driven scanner. One lookup per byte
 * gives the next state and whether a record begins, with no inner loops and
 * no switch.
 *
 * The table has 256 entries per state, built once per separator. An entry
 * is the next state in its low bits plus flags for the rare actions.
 */

import {
  BARE,
  CR,
  FIELD,
  LF,
  LINE,
  LINE_CR,
  QUOTE,
  QUOTED,
  QUOTE_CR,
  QUOTE_SEEN,
  STATES_BY_NUMBER,
  separatorByte,
} from './common.ts';
import type { Begin, LabScanner, State } from './common.ts';

/** Byte values, and so table entries per state. */
const BYTE_VALUES = 256;
/** log2 of BYTE_VALUES, to index a state's row. */
const ROW_SHIFT = 8;
/** States, and so rows in the table. */
const STATES = 7;
/** The low bits of an entry that hold the next state. */
const STATE_BITS = 0x07;
/** A record begins at this byte. */
const BEGIN_HERE = 0x08;
/** A record begins at the CR before this byte. */
const BEGIN_AT_CR = 0x10;
/** This byte is a CR that may begin a record. */
const MARK_CR = 0x20;

/** next is the table entry for byte `b` read in state `s`. */
function next(s: State, b: number, sep: number): number {
  switch (s) {
    case LINE:
      if (b === LF) return LINE;
      if (b === CR) return LINE_CR | MARK_CR;
      if (b === QUOTE) return QUOTED | BEGIN_HERE;
      return (b === sep ? FIELD : BARE) | BEGIN_HERE;
    case LINE_CR:
      if (b === LF) return LINE;
      return (b === sep ? FIELD : BARE) | BEGIN_AT_CR;
    case FIELD:
      if (b === LF) return LINE;
      if (b === QUOTE) return QUOTED;
      return b === sep ? FIELD : BARE;
    case BARE:
      if (b === LF) return LINE;
      return b === sep ? FIELD : BARE;
    case QUOTED:
      return b === QUOTE ? QUOTE_SEEN : QUOTED;
    case QUOTE_SEEN:
      if (b === QUOTE) return QUOTED;
      if (b === sep) return FIELD;
      if (b === LF) return LINE;
      if (b === CR) return QUOTE_CR;
      return QUOTED;
    case QUOTE_CR:
      if (b === LF) return LINE;
      return b === QUOTE ? QUOTE_SEEN : QUOTED;
    default:
      throw new Error(`no state ${String(s)}`);
  }
}

/** tableFor builds the transition table for one separator. */
function tableFor(sep: number): Uint8Array {
  const table = new Uint8Array(STATES * BYTE_VALUES);
  for (const s of STATES_BY_NUMBER) {
    for (let b = 0; b < BYTE_VALUES; b++) {
      table[(s << ROW_SHIFT) | b] = next(s, b, sep);
    }
  }
  return table;
}

/** TableScanner steps a transition table one byte at a time. */
export class TableScanner implements LabScanner {
  state: State = LINE;
  crAt = 0;
  private readonly table: Uint8Array;

  constructor(
    comma: string,
    private readonly begin: Begin,
  ) {
    this.table = tableFor(separatorByte(comma));
  }

  push(chunk: Uint8Array, base: number): void {
    const table = this.table;
    const end = chunk.length;
    let s: number = this.state;

    for (let i = 0; i < end; i++) {
      const entry = table[(s << ROW_SHIFT) | chunk[i]!]!;
      s = entry & STATE_BITS;
      if (entry > STATE_BITS) {
        if (entry & BEGIN_HERE) this.begin(base + i);
        else if (entry & BEGIN_AT_CR) this.begin(this.crAt);
        else this.crAt = base + i;
      }
    }

    this.state = STATES_BY_NUMBER[s]!;
  }
}
