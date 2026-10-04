// Finds where records start, working on raw bytes.
//
// It follows the same rules as csv.ts: a line holding only its terminator is
// skipped, a quote opens a quoted field only as the field's first byte,
// and inside one a quote followed by anything but a quote, the separator or
// the end of the line is data. The bytes it reacts to are all ASCII, so a
// every byte of a multi-byte UTF-8 character is data. tests/ingest/scan.test.ts
// checks it against csv.ts over random input.

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;

/** Between records. A blank line here is skipped. */
const LINE = 0;
/** Between records, after a CR. It is a blank line only if LF follows. */
const LINE_CR = 1;
/** Inside a record, at the first byte of a field. */
const FIELD = 2;
/** Inside an unquoted field, where a quote is data. */
const BARE = 3;
/** Inside a quoted field. */
const QUOTED = 4;
/** Inside a quoted field, just past a quote. */
const QUOTE_SEEN = 5;
/** Inside a quoted field, past a quote and a CR. */
const QUOTE_CR = 6;

/**
 * RecordScanner is fed a file's bytes in order, in chunks of any size, and
 * calls `begin` with the offset of every record's first byte. State carries
 * across chunks. A record is reported when it begins, so pushing the last
 * chunk finishes the scan.
 */
export class RecordScanner {
  private state = LINE;
  private crAt = 0;
  private readonly sep: number;

  constructor(
    comma: string,
    private readonly begin: (offset: number) => void,
  ) {
    const sep = comma.charCodeAt(0);
    if (comma.length !== 1 || sep >= 0x80 || sep === QUOTE || sep === LF || sep === CR) {
      throw new Error(`${JSON.stringify(comma)} cannot separate fields`);
    }
    this.sep = sep;
  }

  /**
   * push scans `chunk`, whose first byte sits at offset `base` in the file.
   * The FIELD, BARE and QUOTED states run an inner loop that looks only for
   * the bytes that change state.
   */
  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    const end = chunk.length;
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
          this.begin(base + i);
          s = b === QUOTE ? QUOTED : b === sep ? FIELD : BARE;
          break;

        case LINE_CR:
          if (b === LF) {
            s = LINE;
            break;
          }
          // The CR was the first byte of an unquoted field, so a quote after it
          // is data too.
          this.begin(this.crAt);
          s = b === sep ? FIELD : BARE;
          break;

        case FIELD:
        case BARE: {
          // Unquoted, until the line ends or a quote comes. A quote at a
          // field's first byte opens a quoted field; anywhere else it is data.
          // The byte before it says which; for the byte at `i` the state does.
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
          // Inside quotes, only a quote matters.
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
          if (b === QUOTE) s = QUOTED; // `""` is one literal quote
          else if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          else if (b === CR) s = QUOTE_CR;
          else s = QUOTED; // a bare quote, which LazyQuotes keeps
          break;

        case QUOTE_CR:
          // CRLF ends the line and the field. A CR followed by anything else
          // is data, and the quote before it was a bare one.
          if (b === LF) s = LINE;
          else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
          break;
      }
      i++;
    }

    this.state = s;
  }
}

/** bomLength is 3 when `head` starts with the UTF-8 byte order mark, else 0. */
export function bomLength(head: Uint8Array): number {
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
}
