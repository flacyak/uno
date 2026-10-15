/**
 * @fileoverview Variant (a): RecordScanner with its two inner loops replaced
 * by Uint8Array.prototype.indexOf.
 *
 * QUOTED searches for the next quote. FIELD and BARE need the nearer of the
 * next LF and the next quote, so the scanner remembers where each search
 * last landed and searches again only once the scan has passed that point.
 * No byte is searched twice for the same needle within a push.
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
import type { Begin, LabScanner, State } from './common.ts';
import { unreachable } from '@never';

/** What indexOf returns when the byte is absent. */
const ABSENT = -1;

/** IndexOfScanner finds record starts with indexOf in its inner loops. */
export class IndexOfScanner implements LabScanner {
  private readonly begin: Begin;

  state: State = LINE;
  crAt = 0;
  private readonly sep: number;

  constructor(comma: string, begin: Begin) {
    this.begin = begin;
    this.sep = separatorByte(comma);
  }

  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    const end = chunk.length;
    let s = this.state;
    let i = 0;
    // The next LF and quote at or past where each was last searched from;
    // `end` when there is none before the end of the chunk. Below `i` means
    // stale.
    let nextLf = ABSENT;
    let nextQuote = ABSENT;

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
          this.begin(base + i);
          s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
          break;
        }

        case LINE_CR: {
          const b = chunk[i]!;
          if (b === LF) {
            s = LINE;
            break;
          }
          this.begin(this.crAt);
          s = b === sep ? FIELD : BARE;
          break;
        }

        case FIELD:
        case BARE: {
          if (nextLf < i) nextLf = found(chunk.indexOf(LF, i), end);
          if (nextQuote < i) nextQuote = found(chunk.indexOf(QUOTE, i), end);
          if (nextLf < nextQuote) {
            s = LINE;
            i = nextLf;
            break;
          }
          if (nextQuote === end) {
            // Neither before the end: the state is set by the last byte.
            s = chunk[end - 1] === sep ? FIELD : BARE;
            i = end;
            continue;
          }
          const j = nextQuote;
          s = (j === i ? s === FIELD : chunk[j - 1] === sep) ? QUOTED : BARE;
          i = j;
          break;
        }

        case QUOTED:
          if (nextQuote < i) nextQuote = found(chunk.indexOf(QUOTE, i), end);
          if (nextQuote === end) {
            i = end;
            continue;
          }
          s = QUOTE_SEEN;
          i = nextQuote;
          break;

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
  }
}

/** found maps an indexOf miss to `end`, the position past every byte. */
function found(at: number, end: number): number {
  return at === ABSENT ? end : at;
}
