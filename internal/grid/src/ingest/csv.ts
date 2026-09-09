// The subset of Go's encoding/csv that uno actually uses: `LazyQuotes` on,
// `FieldsPerRecord` off, a configurable separator.
//
// Hand-ported rather than taken from npm. Lazy quoting is exactly where a
// third-party reader disagrees -- it decides for itself whether a stray quote
// in an unquoted field is data or a syntax error -- and a real export with one
// stray quote in 4,812 rows has to open, not fail. The rules below are Go's,
// including the ones that look like quirks: a bare `\r` before end of file is
// dropped, a `\r\n` inside a quoted field becomes a `\n`, and a line holding
// nothing but its terminator produces no record at all.

/** 1 when the line ends with a newline, 0 otherwise. Go calls this lengthNL. */
function lengthNL(line: string): number {
  return line.endsWith("\n") ? 1 : 0;
}

/**
 * Lines hands out one line at a time, including its terminator, with `\r\n`
 * normalised to `\n` the way Go's readLine does.
 */
class Lines {
  private i = 0;

  constructor(private readonly s: string) {}

  next(): string | undefined {
    if (this.i >= this.s.length) return undefined;

    const nl = this.s.indexOf("\n", this.i);
    let line: string;
    if (nl < 0) {
      line = this.s.slice(this.i);
      this.i = this.s.length;
      // For backwards compatibility Go drops a trailing \r before end of file.
      if (line.endsWith("\r")) line = line.slice(0, -1);
    } else {
      line = this.s.slice(this.i, nl + 1);
      this.i = nl + 1;
      if (line.endsWith("\r\n")) line = line.slice(0, -2) + "\n";
    }
    return line;
  }
}

/**
 * readAll reads every record. Rows may be ragged -- that is what
 * `FieldsPerRecord: -1` buys -- and the caller decides what to do about it.
 */
export function readAll(text: string, comma: string): string[][] {
  const lines = new Lines(text);
  const records: string[][] = [];

  for (;;) {
    const rec = readRecord(lines, comma);
    if (rec === undefined) break;
    records.push(rec);
  }
  return records;
}

function readRecord(lines: Lines, comma: string): string[] | undefined {
  // Skip lines holding nothing but their terminator. A blank line in the middle
  // of an export is spacing, not a row of empty cells.
  let line: string;
  for (;;) {
    const got = lines.next();
    if (got === undefined) return undefined;
    if (got.length === lengthNL(got)) continue;
    line = got;
    break;
  }

  const fields: string[] = [];
  let buf = "";

  parseField: for (;;) {
    if (!line.startsWith('"')) {
      // A non-quoted field runs to the next separator or to the end of the line.
      // A quote inside one is data, because LazyQuotes is on.
      const i = line.indexOf(comma);
      if (i >= 0) {
        fields.push(line.slice(0, i));
        line = line.slice(i + comma.length);
        continue;
      }
      fields.push(line.slice(0, line.length - lengthNL(line)));
      break parseField;
    }

    // A quoted field, which may run over more than one line.
    line = line.slice(1);
    for (;;) {
      const i = line.indexOf('"');
      if (i >= 0) {
        buf += line.slice(0, i);
        line = line.slice(i + 1);

        if (line.startsWith('"')) {
          // `""` is one literal quote.
          buf += '"';
          line = line.slice(1);
        } else if (line.startsWith(comma)) {
          line = line.slice(comma.length);
          fields.push(buf);
          buf = "";
          continue parseField;
        } else if (lengthNL(line) === line.length) {
          fields.push(buf);
          buf = "";
          break parseField;
        } else {
          // A bare quote inside a quoted field. LazyQuotes keeps it.
          buf += '"';
        }
        continue;
      }

      if (line.length > 0) {
        // The field carries on onto the next line, newline and all.
        buf += line;
        const next = lines.next();
        if (next === undefined) {
          // A quoted field the file ended in the middle of.
          fields.push(buf);
          buf = "";
          break parseField;
        }
        line = next;
        continue;
      }

      fields.push(buf);
      buf = "";
      break parseField;
    }
  }

  return fields;
}
