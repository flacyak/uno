/** The delimiters to guess between, in tie order: tab, pipe, semicolon, comma. */
const CANDIDATES = ["\t", "|", ";", ","];

/** The candidate that is also a decimal mark. */
const COMMA = ",";

/** SNIFF_LINES is how many records are checked for a consistent field count. */
const SNIFF_LINES = 5;

/** How many characters of the head to look at. */
const PEEK = 64 << 10;

/**
 * sniffDelimiter guesses the delimiter from the first records. The candidate
 * with the highest field count that is consistent across every record wins;
 * the default is a comma. Once another candidate fits, a comma between two
 * digits is read as a decimal mark.
 */
export function sniffDelimiter(text: string): string {
  const lines = headLines(text.slice(0, PEEK));
  if (lines.length === 0) return COMMA;

  let best = COMMA;
  let bestFields = 1;
  for (const c of CANDIDATES) {
    const decimal = c === COMMA && bestFields > 1;
    const [fields, consistent] = fieldCount(lines, c, decimal);
    // A character is consistent when every line yields the same field count.
    if (consistent && fields > bestFields) {
      best = c;
      bestFields = fields;
    }
  }
  return best;
}

/**
 * headLines splits the peeked text into up to SNIFF_LINES whole records. A
 * line break ends a record only outside quotes. An unterminated last record
 * is dropped, except when the text is a single line with balanced quotes, in
 * which case it is the one record.
 */
function headLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuote = false;
  for (let i = 0; i < s.length && out.length < SNIFF_LINES; i++) {
    const r = s[i];
    if (r === '"') inQuote = !inQuote;
    else if (r === "\n" && !inQuote) {
      pushLine(out, s.slice(start, i));
      start = i + 1;
    }
  }
  if (out.length === 0 && start === 0 && !inQuote) pushLine(out, s);
  return out;
}

/** pushLine keeps a record that holds something, with its CR stripped. */
function pushLine(out: string[], l: string): void {
  if (l.endsWith("\r")) l = l.slice(0, -1);
  if (l !== "") out.push(l);
}

/**
 * fieldCount returns how many fields `sep` yields per line, and whether every
 * line agreed. Only a separator outside quotes counts. With `decimal`, one
 * between two digits is read as a decimal mark.
 */
function fieldCount(lines: string[], sep: string, decimal: boolean): [number, boolean] {
  let want = -1;
  for (const l of lines) {
    let n = 1;
    let inQuote = false;
    for (let i = 0; i < l.length; i++) {
      const r = l[i];
      if (r === '"') inQuote = !inQuote;
      else if (r === sep && !inQuote && !(decimal && isDigit(l[i - 1]) && isDigit(l[i + 1]))) n++;
    }
    if (want === -1) want = n;
    else if (n !== want) return [0, false];
  }
  return [want, want > 1];
}

const DIGITS = "0123456789";

function isDigit(r: string | undefined): boolean {
  return r !== undefined && DIGITS.includes(r);
}

/**
 * Encoding is a file's text encoding. "other" covers Windows-1252, Latin-1
 * and the rest.
 */
export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "other";

const NUL = 0x00;

/** The two bytes of the UTF-16 byte order mark. */
const UTF16_MARK_LOW = 0xff;
const UTF16_MARK_HIGH = 0xfe;

/** How many bytes a UTF-16 code unit is. */
const UTF16_UNIT_BYTES = 2;

/** The most code units per NUL for the head to count as UTF-16. */
const UTF16_UNITS_PER_NUL = 16;

/**
 * sniffEncoding guesses the encoding from the head of a file. A UTF-16 byte
 * order mark decides. Otherwise the NULs do: UTF-16 has one in every ASCII
 * character, at odd offsets when little-endian and even when big-endian, and
 * they must come at least once per UTF16_UNITS_PER_NUL units. Otherwise it is
 * "utf-8" when the head decodes as UTF-8, and "other" when decoding fails.
 */
export function sniffEncoding(head: Uint8Array): Encoding {
  if (head[0] === UTF16_MARK_LOW && head[1] === UTF16_MARK_HIGH) return "utf-16le";
  if (head[0] === UTF16_MARK_HIGH && head[1] === UTF16_MARK_LOW) return "utf-16be";

  let first = 0;
  let second = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== NUL) continue;
    if (i % UTF16_UNIT_BYTES === 0) first++;
    else second++;
  }
  const units = Math.ceil(head.length / UTF16_UNIT_BYTES);
  if (first + second > 0 && Math.max(first, second) * UTF16_UNITS_PER_NUL >= units) {
    return second >= first ? "utf-16le" : "utf-16be";
  }

  try {
    // Streaming, so a character cut in half at the end of the head is
    // accepted.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return "utf-8";
  } catch {
    return "other";
  }
}
