/**
 * The separators worth guessing between, in the order a tie goes: a tab is
 * never prose, a pipe hardly ever, a semicolon sometimes, and a comma sits
 * inside fields all the time, after a surname or between the digits of a
 * European decimal. Anything else is rare enough that being wrong about it is
 * better handled by the person telling us.
 */
const CANDIDATES = ["\t", "|", ";", ","];

/** The candidate that is also a decimal mark, and is read as one when it can be. */
const COMMA = ",";

/**
 * sniffLines bounds the peek. A delimiter that is not consistent across the
 * first few records is not the delimiter.
 */
const SNIFF_LINES = 5;

/** How much of the head to look at. Go peeks this many bytes off a buffered
 * reader; here the text is already in hand, so it is a slice. */
const PEEK = 64 << 10;

/**
 * sniffDelimiter guesses from the bytes rather than asking.
 *
 * A dialog asking for a delimiter is a question the file already answers; the
 * guess is shown in the status bar so it can be seen, and the open never blocks
 * on it.
 *
 * A comma is the one candidate that has another job: 1,5;2,5 is two decimals
 * between a semicolon, and the comma count agrees on every line of such a
 * file. So once another separator fits, a comma between two digits is a
 * decimal mark and is not counted. With nothing else fitting, 1,2,3 is three
 * columns as it always was.
 */
export function sniffDelimiter(text: string): string {
  const lines = headLines(text.slice(0, PEEK));
  if (lines.length === 0) return COMMA;

  let best = COMMA;
  let bestFields = 1;
  for (const c of CANDIDATES) {
    const decimal = c === COMMA && bestFields > 1;
    const [fields, consistent] = fieldCount(lines, c, decimal);
    // Consistency is what separates a real delimiter from a character that
    // happens to appear: a ';' inside prose shows up on some lines only.
    if (consistent && fields > bestFields) {
      best = c;
      bestFields = fields;
    }
  }
  return best;
}

/**
 * headLines splits the peeked text into whole records. A quoted field can
 * hold a line break, and the record it is in is counted once, not once per
 * line: counted per line, the two halves of "two\nlines" would each get a
 * field count of their own, and no delimiter would be consistent.
 *
 * The last record is dropped unless it was terminated, because a record cut
 * in half by the peek limit has a field count that means nothing and would
 * fail every consistency check. A quote the peek leaves open is the same
 * cut, and nothing inside it is a delimiter. A text with no line break at all
 * is one record, whole.
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

/** pushLine keeps a record that holds something, without its CR. */
function pushLine(out: string[], l: string): void {
  if (l.endsWith("\r")) l = l.slice(0, -1);
  if (l !== "") out.push(l);
}

/**
 * fieldCount reports how many fields the separator yields per line, and whether
 * every line agreed. Quoted sections are skipped so a comma inside
 * "Okafor, Ada" is not counted as a separator, and with `decimal` so is a
 * separator between two digits, which is the decimal mark of 1,5.
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
 * Encoding is which text encoding a file's bytes are in. "other" is bytes
 * that are neither UTF-8 nor UTF-16: Windows-1252, Latin-1, and the rest,
 * which the bytes alone do not tell apart.
 */
export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "other";

const NUL = 0x00;

/** The two bytes UTF-16 opens with, in the order each byte order writes them. */
const UTF16_MARK_LOW = 0xff;
const UTF16_MARK_HIGH = 0xfe;

/** How many bytes a UTF-16 code unit is. */
const UTF16_UNIT_BYTES = 2;

/**
 * How many code units apart the NULs can be and still be UTF-16. Plain text
 * has one in every unit; another script has one at every separator and
 * digit, a few units apart. A NUL that strayed into a UTF-8 export, as a
 * database writes one for a binary field, is one in thousands.
 */
const UTF16_UNITS_PER_NUL = 16;

/**
 * sniffEncoding guesses the encoding from the head of a file.
 *
 * A UTF-16 byte order mark settles it. Without one, the NULs do: a UTF-8
 * table has none to speak of, and UTF-16 has one in every character of plain
 * ASCII, second in each pair when it is little-endian and first when it is
 * big. One NUL is a stray and not an encoding, so the NULs have to come as
 * often as UTF-16 writes them. What is left is UTF-8 if it decodes as UTF-8.
 * A UTF-8 byte order mark makes no difference: with it or without, the
 * encoding is UTF-8.
 *
 * It answers for the head alone. A file that is plain ASCII as far as the
 * head goes reads as UTF-8, which it is so far.
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
    // Streaming, so a character the head cuts in half is not held against it.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return "utf-8";
  } catch {
    return "other";
  }
}
