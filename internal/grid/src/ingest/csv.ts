// A port of the subset of Go's encoding/csv that uno uses: `LazyQuotes` on,
// `FieldsPerRecord` off, a configurable separator.
//
// The rules are Go's, including: a bare `\r` before end of file is dropped,
// a `\r\n` inside a quoted field becomes `\n`, and a line holding only its
// terminator is skipped.

/** lengthNL mirrors Go's: 1 when the line ends with a newline, 0 otherwise. */
function lengthNL(line: string): number {
  return line.endsWith("\n") ? 1 : 0;
}

/**
 * Lines yields one line at a time, including its terminator, with `\r\n`
 * normalised to `\n` as Go's readLine does.
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
      // Go drops a trailing \r before end of file.
      if (line.endsWith("\r")) line = line.slice(0, -1);
    } else {
      line = this.s.slice(this.i, nl + 1);
      this.i = nl + 1;
      if (line.endsWith("\r\n")) line = line.slice(0, -2) + "\n";
    }
    return line;
  }
}

/** readAll reads every record. Rows may be ragged. */
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
  // Skip lines holding only their terminator.
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
      // An unquoted field runs to the next separator or the end of the line.
      // A quote inside it is data (LazyQuotes).
      const i = line.indexOf(comma);
      if (i >= 0) {
        fields.push(line.slice(0, i));
        line = line.slice(i + comma.length);
        continue;
      }
      fields.push(line.slice(0, line.length - lengthNL(line)));
      break parseField;
    }

    // A quoted field, which may span lines.
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
        // The field continues on the next line, newline included.
        buf += line;
        const next = lines.next();
        if (next === undefined) {
          // The file ended inside a quoted field.
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
