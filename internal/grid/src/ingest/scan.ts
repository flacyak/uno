// Where records start, found without decoding them.
//
// An index over a file larger than memory cannot hand its text to `readAll`, so
// this walks the raw bytes under the same rules and reports only the offset of
// each record's first byte. The bytes it acts on are all ASCII -- the quote, the
// separator, CR and LF -- and no byte inside a multi-byte UTF-8 character is
// ever one of those, so it never decodes anything.
//
// It has to agree with csv.ts exactly, quirks included: a line holding only its
// terminator is not a record, a quote opens a quoted field only as the field's
// first byte, and inside one a quote followed by anything but a quote, the
// separator or the end of the line is data. tests/ingest/scan.test.ts holds the
// two to each other over random input.

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;

/** Between records, where a blank line is skipped rather than counted. */
const LINE = 0;
/** Between records, having seen a CR that is blank-line only if LF follows. */
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
 * calls `begin` with the offset of every record's first byte.
 *
 * Its state carries across chunks, so a quoted field or a CRLF split by a chunk
 * boundary reads the same as one that is not. There is no finish step: a record
 * is reported when it begins, and the one thing end of file changes -- a lone
 * CR at the very end is dropped -- changes no record's start.
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

  /** push scans `chunk`, whose first byte sits at `base` in the file. */
  push(chunk: Uint8Array, base: number): void {
    const sep = this.sep;
    let s = this.state;

    for (let i = 0; i < chunk.length; i++) {
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
          if (b === QUOTE) s = QUOTED;
          else if (b === LF) s = LINE;
          else if (b !== sep) s = BARE;
          break;

        case BARE:
          if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          break;

        case QUOTED:
          if (b === QUOTE) s = QUOTE_SEEN;
          break;

        case QUOTE_SEEN:
          if (b === QUOTE) s = QUOTED; // `""` is one literal quote
          else if (b === sep) s = FIELD;
          else if (b === LF) s = LINE;
          else if (b === CR) s = QUOTE_CR;
          else s = QUOTED; // a bare quote, which LazyQuotes keeps
          break;

        case QUOTE_CR:
          // CRLF ends the line, and so the field. A CR before anything else
          // made the quote a bare one and is data itself.
          if (b === LF) s = LINE;
          else s = b === QUOTE ? QUOTE_SEEN : QUOTED;
          break;
      }
    }

    this.state = s;
  }
}

/** The UTF-8 byte order mark, which the decoder strips at the start of a file. */
export function bomLength(head: Uint8Array): number {
  return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
}
