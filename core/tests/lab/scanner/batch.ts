/**
 * @fileoverview Variant (c): the SWAR scanner writing begins into a
 * preallocated Float64Array instead of calling back once per record.
 *
 * The array is handed to `many` when it fills and at the end of each push,
 * so a consumer such as BulkIndex takes a whole run of begins at once.
 * Float64Array holds any file offset exactly, as a number does.
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
} from './common.ts';
import type { LabScanner, Many, State } from './common.ts';
import { LITTLE_ENDIAN, findLineOrQuote, findQuote, wordsOf } from './swar.ts';
import { unreachable } from '@never';

/** Begins held before they are handed on: 32 KB of offsets. */
export const BATCH_BEGINS = 4096;

/** BatchScanner is SwarScanner reporting begins in batches. */
export class BatchScanner implements LabScanner {
  private readonly many: Many;

  state: State = LINE;
  crAt = 0;
  private readonly sep: number;
  private readonly begins = new Float64Array(BATCH_BEGINS);
  private count = 0;

  constructor(comma: string, many: Many) {
    this.many = many;
    if (!LITTLE_ENDIAN)
      throw new Error('BatchScanner needs a little-endian machine');
    this.sep = separatorByte(comma);
  }

  /** add records one begin, handing the batch on first when it is full. */
  private add(offset: number): void {
    if (this.count === BATCH_BEGINS) {
      this.many(this.begins, this.count, 0);
      this.count = 0;
    }
    this.begins[this.count++] = offset;
  }

  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    const end = chunk.length;
    const view = wordsOf(chunk);
    let s = this.state;
    let i = 0;

    while (i < end) {
      switch (s) {
        case LINE: {
          const b = chunk[i]!;
          if (b === LF) break;
          if (b === CR) {
            s = LINE_CR;
            this.crAt = base + i;
            break;
          }
          this.add(base + i);
          s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
          break;
        }

        case LINE_CR: {
          const b = chunk[i]!;
          if (b === LF) {
            s = LINE;
            break;
          }
          this.add(this.crAt);
          s = b === sep ? FIELD : BARE;
          break;
        }

        case FIELD:
        case BARE: {
          const j = findLineOrQuote(chunk, view, i, end);
          if (j === end) {
            s = chunk[end - 1] === sep ? FIELD : BARE;
            i = end;
            continue;
          }
          if (chunk[j] === LF) s = LINE;
          else if (j === i ? s === FIELD : chunk[j - 1] === sep) s = QUOTED;
          else s = BARE;
          i = j;
          break;
        }

        case QUOTED: {
          const j = findQuote(chunk, view, i, end);
          if (j === end) {
            i = end;
            continue;
          }
          s = QUOTE_SEEN;
          i = j;
          break;
        }

        case QUOTE_SEEN: {
          const b = chunk[i]!;
          if (b === QUOTE) s = QUOTED;
          else if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          else if (b === CR) s = QUOTE_CR;
          else s = QUOTED;
          break;
        }

        case QUOTE_CR: {
          const b = chunk[i]!;
          if (b === LF) s = LINE;
          else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
          break;
        }
        default:
          return unreachable(s);
      }
      i++;
    }

    this.state = s;
    if (this.count > 0) {
      this.many(this.begins, this.count, 0);
      this.count = 0;
    }
  }
}
