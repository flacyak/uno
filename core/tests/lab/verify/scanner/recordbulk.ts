/**
 * @fileoverview RecordScanner from core/src/ingest/scan.ts, byte loop
 * unchanged, with one difference: begins go into a Float64Array and are
 * handed on as runs, so BulkIndex.beginMany can take them. This isolates the
 * bulk handoff from any change to how bytes are scanned.
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
  separatorByte,
} from '../../scanner/common.ts';
import type { LabScanner, Many, State } from '../../scanner/common.ts';
import { unreachable } from '@never';

/** Begins held before they are handed on: 32 KB of offsets. */
const RUN_BEGINS = 4096;

/** RecordBulkScanner is RecordScanner reporting begins in runs. */
export class RecordBulkScanner implements LabScanner {
  state: State = LINE;
  crAt = 0;
  private readonly sep: number;
  private readonly begins = new Float64Array(RUN_BEGINS);

  constructor(
    comma: string,
    private readonly many: Many,
  ) {
    this.sep = separatorByte(comma);
  }

  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    const end = chunk.length;
    const begins = this.begins;
    let count = 0;
    let s = this.state;
    let i = 0;

    while (i < end) {
      const b = chunk[i]!;
      switch (s) {
        case LINE:
          if (b === LF) break;
          if (b === CR) {
            s = LINE_CR;
            this.crAt = base + i;
            break;
          }
          if (count === RUN_BEGINS) {
            this.many(begins, count, 0);
            count = 0;
          }
          begins[count++] = base + i;
          s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
          break;

        case LINE_CR:
          if (b === LF) {
            s = LINE;
            break;
          }
          if (count === RUN_BEGINS) {
            this.many(begins, count, 0);
            count = 0;
          }
          begins[count++] = this.crAt;
          s = b === sep ? FIELD : BARE;
          break;

        case FIELD:
        case BARE: {
          let j = i;
          let c = b;
          while (c !== LF && c !== QUOTE) {
            if (++j === end) break;
            c = chunk[j]!;
          }
          if (j === end) {
            s = j === i ? s : chunk[j - 1] === sep ? FIELD : BARE;
            i = j;
            continue;
          }
          if (c === LF) s = LINE;
          else if (j === i ? s === FIELD : chunk[j - 1] === sep) s = QUOTED;
          else s = BARE;
          i = j;
          break;
        }

        case QUOTED: {
          let j = i;
          while (chunk[j] !== QUOTE) {
            if (++j === end) break;
          }
          if (j === end) {
            i = j;
            continue;
          }
          s = QUOTE_SEEN;
          i = j;
          break;
        }

        case QUOTE_SEEN:
          if (b === QUOTE) s = QUOTED;
          else if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          else if (b === CR) s = QUOTE_CR;
          else s = QUOTED;
          break;

        case QUOTE_CR:
          if (b === LF) s = LINE;
          else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
          break;
        default:
          return unreachable(s);
      }
      i++;
    }

    this.state = s;
    if (count > 0) this.many(begins, count, 0);
  }
}
