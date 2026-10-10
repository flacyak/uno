// Ports of Go's string functions whose JavaScript equivalents give a different
// answer.

/**
 * runes splits a string into code points, like a Go `[]rune`. Parsers index
 * runes and report positions as 1-based rune offsets.
 */
export function runes(s: string): string[] {
  return Array.from(s);
}

/** runeLen is the code-point count, counted in one pass. */
export function runeLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * compareStrings orders by code point, as `strings.Compare` and `sort.Strings`
 * do. JavaScript's default comparison uses UTF-16 code units, which order
 * differently above the BMP.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;

  // Walked in place; a sort calls this once per comparison.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n;) {
    const c = a.codePointAt(i)!;
    const d = b.codePointAt(i)!;
    if (c !== d) return c < d ? -1 : 1;
    i += c > MAX_BMP ? SURROGATE_PAIR_UNITS : 1;
  }
  // The shorter is a prefix of the longer.
  return a.length < b.length ? -1 : 1;
}

/** The last code point one UTF-16 unit holds. Above it a surrogate pair does. */
export const MAX_BMP = 0xffff;
export const SURROGATE_PAIR_UNITS = 2;

// unicode.IsLetter is category L and unicode.IsDigit is category Nd.
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

// unicode.IsSpace is the Unicode White_Space property. JavaScript's `\s`
// leaves out U+0085 and adds U+FEFF.
const SPACE = /\p{White_Space}/u;

export function isLetter(r: string): boolean {
  return LETTER.test(r);
}

export function isDigit(r: string): boolean {
  return DIGIT.test(r);
}

export function isSpace(r: string): boolean {
  return SPACE.test(r);
}

// Leading and trailing White_Space, in one pattern.
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** trimSpace mirrors strings.TrimSpace: trims unicode.IsSpace from both ends. */
export function trimSpace(s: string): string {
  return s.replace(EDGE_SPACE, "");
}

/**
 * toUpper and toLower mirror Go's simple case mapping: one rune in, one rune
 * out. JavaScript's full mapping can grow a string (eszett to "SS"). Each
 * rune takes the full mapping, and keeps the original where that mapping is
 * longer than one rune.
 */
export function toUpper(s: string): string {
  let out = "";
  for (const r of s) {
    const u = r.toUpperCase();
    out += runeLen(u) === 1 ? u : r;
  }
  return out;
}

/**
 * U+0130, capital I with dot above. Go lowercases it to a plain "i";
 * JavaScript produces "i" plus a combining dot.
 */
const DOTTED_CAPITAL_I = "İ";

export function toLower(s: string): string {
  let out = "";
  for (const r of s) {
    if (r === DOTTED_CAPITAL_I) {
      out += "i";
      continue;
    }
    const l = r.toLowerCase();
    out += runeLen(l) === 1 ? l : r;
  }
  return out;
}

/** equalFold mirrors strings.EqualFold, using the simple mappings above. */
export function equalFold(a: string, b: string): boolean {
  return toLower(a) === toLower(b);
}
