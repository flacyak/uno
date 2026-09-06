// Go's string semantics, where JavaScript's differ.
//
// Every function here exists because the obvious JavaScript does something else
// and does it quietly: no exception, no type error, just a different answer in a
// cell. They are the first thing written and the first thing tested, because a
// divergence found halfway through porting `pattern` is one that has already
// been worked around three times.

/**
 * runes splits into code points, which is what a Go `[]rune` is.
 *
 * Every parser in the core indexes runes and reports `at character %d` in
 * 1-based rune offsets. Indexing a JavaScript string is UTF-16, so a single
 * astral character makes the error positions and the slice offsets disagree.
 */
export function runes(s: string): string[] {
  return Array.from(s);
}

/** Rune count. `[...s].length`, without building the array. */
export function runeLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * compareStrings orders the way `sort.Strings` and `strings.Compare` do.
 *
 * Go compares the UTF-8 bytes, which is the same as comparing code points --
 * UTF-8 is built so that it is. JavaScript compares UTF-16 code units, and the
 * two disagree above the BMP, because a surrogate pair sorts below U+E000 as
 * code units and above it as code points.
 *
 * `Refs`, `DownstreamOf`, the library listing and the recogniser's ranking all
 * take their order from this.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;

  const x = runes(a);
  const y = runes(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const c = x[i]!.codePointAt(0)!;
    const d = y[i]!.codePointAt(0)!;
    if (c !== d) return c < d ? -1 : 1;
  }
  if (x.length === y.length) return 0;
  return x.length < y.length ? -1 : 1;
}

// unicode.IsLetter is category L and unicode.IsDigit is category Nd, so
// `region` is a legal column name and `[a-zA-Z]` is not the test.
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

// unicode.IsSpace is the Unicode White_Space property. JavaScript's `\s` is a
// different set: it leaves out U+0085 and adds U+FEFF.
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

/** strings.TrimSpace: both ends, by unicode.IsSpace rather than by `trim()`. */
export function trimSpace(s: string): string {
  const r = runes(s);
  let i = 0;
  let j = r.length;
  while (i < j && isSpace(r[i]!)) i++;
  while (j > i && isSpace(r[j - 1]!)) j--;
  return r.slice(i, j).join("");
}

/**
 * toUpper and toLower are Go's *simple* case mapping: one rune in, one rune
 * out, never a change in length.
 *
 * JavaScript uses full case mapping, so `"ss".toUpperCase()` on an eszett gives
 * two characters where Go gives back the one it was handed. The transform
 * language's `upper()` step runs over whole columns, so the difference is data
 * being rewritten rather than a formatting quirk.
 *
 * The rule is: take the full mapping, and keep the original wherever it grew.
 * Every rune whose uppercase expands has no simple uppercase mapping in Unicode,
 * so identity is the right answer for all of them.
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
 * The one rune whose *lowercase* expands and still has a simple mapping:
 * U+0130, capital I with dot above, which Go lowercases to a plain "i" while
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

/** strings.EqualFold, over the simple mappings above. */
export function equalFold(a: string, b: string): boolean {
  return toLower(a) === toLower(b);
}
