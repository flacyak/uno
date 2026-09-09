/**
 * The separators worth guessing between. Anything else is rare enough that
 * being wrong about it is better handled by the person telling us.
 */
const CANDIDATES = [",", "\t", ";", "|"];

/**
 * sniffLines bounds the peek. A delimiter that is not consistent across the
 * first few lines is not the delimiter.
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
 */
export function sniffDelimiter(text: string): string {
  const lines = headLines(text.slice(0, PEEK));
  if (lines.length === 0) return ",";

  let best = ",";
  let bestFields = 1;
  for (const c of CANDIDATES) {
    const [fields, consistent] = fieldCount(lines, c);
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
 * headLines splits the peeked text into whole lines. The last line is dropped
 * unless it was terminated, because a line cut in half by the peek limit has a
 * field count that means nothing and would fail every consistency check.
 */
function headLines(s: string): string[] {
  const last = s.lastIndexOf("\n");
  if (last >= 0) s = s.slice(0, last + 1);

  const out: string[] = [];
  for (let l of s.split("\n")) {
    if (out.length === SNIFF_LINES) break;
    if (l.endsWith("\r")) l = l.slice(0, -1);
    if (l !== "") out.push(l);
  }
  return out;
}

/**
 * fieldCount reports how many fields the separator yields per line, and whether
 * every line agreed. Quoted sections are skipped so a comma inside
 * "Okafor, Ada" is not counted as a separator.
 */
function fieldCount(lines: string[], sep: string): [number, boolean] {
  let want = -1;
  for (const l of lines) {
    let n = 1;
    let inQuote = false;
    for (const r of l) {
      if (r === '"') inQuote = !inQuote;
      else if (r === sep && !inQuote) n++;
    }
    if (want === -1) want = n;
    else if (n !== want) return [0, false];
  }
  return [want, want > 1];
}
