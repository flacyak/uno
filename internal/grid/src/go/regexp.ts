// Go's regexp, where JavaScript's differs.
//
// The patterns the recogniser induces are simple -- literals, character
// classes, anchors, `+` -- so RE2 and JavaScript agree on what they match. They
// disagree about three things around the edges: what a replacement string
// means, what units a match index is in, and which characters need escaping.

import { runes } from "./strings.ts";

/**
 * META is exactly the set `regexp.QuoteMeta` escapes.
 *
 * The set has to be exactly this because `literalOf` in the transform language
 * inverts it character for character, to turn a pattern back into the English a
 * proposal is phrased in. A wider set makes it refuse patterns it should name;
 * a narrower one makes it name patterns it should refuse.
 */
export const META = "\\.+*?()|[]{}^$";

export function isMeta(c: string): boolean {
  return META.includes(c);
}

/** regexp.QuoteMeta. */
export function quoteMeta(s: string): string {
  let out = "";
  for (const r of s) out += isMeta(r) ? "\\" + r : r;
  return out;
}

/**
 * compile builds a pattern the way Go's `regexp.Compile` does, and throws where
 * Go returns an error.
 *
 * The `u` flag is deliberate: it makes the pattern match code points, which is
 * what RE2 does, and it makes an empty match advance by a whole character
 * rather than by half a surrogate pair. Every escape the induced patterns use
 * is a legal identity escape under `u`.
 */
export function compile(src: string, flags = ""): RegExp {
  return new RegExp(src, flags.includes("u") ? flags : flags + "u");
}

function globalize(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

/**
 * replaceAllLiteral is `Regexp.ReplaceAllLiteralString`: every occurrence, with
 * the replacement taken as text.
 *
 * `String.replaceAll` with a string replacement expands `$&`, `$1` and `$'`. A
 * person who types `$1` into a cell has to get `$1` back, so the replacement
 * goes through a function, where JavaScript does no expansion.
 */
export function replaceAllLiteral(re: RegExp, s: string, lit: string): string {
  return s.replace(globalize(re), () => lit);
}

/**
 * findAllIndex is `Regexp.FindAllStringIndex(s, -1)`, in **code-point** offsets
 * rather than Go's byte offsets.
 *
 * Returning code points is the whole point of the shim. Go's caller has to
 * convert the byte offsets it gets back into rune offsets before it can do
 * slice arithmetic with them; converting here instead means the caller never
 * holds two kinds of offset at once and the conversion helper disappears.
 *
 * Empty matches follow Go's rule: one immediately after a previous match is
 * dropped, and the scan advances a character rather than spinning.
 */
export function findAllIndex(re: RegExp, s: string): Array<[number, number]> {
  const g = globalize(re);
  g.lastIndex = 0;

  // Code-unit index -> code-point index, built once rather than per match.
  const cp: number[] = [];
  let n = 0;
  for (let i = 0; i < s.length;) {
    const r = String.fromCodePoint(s.codePointAt(i)!);
    for (let k = 0; k < r.length; k++) cp[i + k] = n;
    i += r.length;
    n++;
  }
  cp[s.length] = n;

  const out: Array<[number, number]> = [];
  let prevEnd = -1;
  for (;;) {
    const m = g.exec(s);
    if (m === null) break;

    const start = m.index;
    const end = start + m[0].length;
    const empty = end === start;

    if (!(empty && start === prevEnd)) {
      out.push([cp[start]!, cp[end]!]);
      prevEnd = end;
    }

    if (empty) {
      // exec does not advance on an empty match; Go advances one rune.
      const here = s.codePointAt(start) ?? 0;
      const next = here > 0xffff ? start + 2 : start + 1;
      if (next > s.length) break;
      g.lastIndex = next;
    }
  }
  return out;
}

/** strings.Index, in code-point offsets, and -1 for absent. */
export function indexOfRunes(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  if (at < 0) return -1;
  return runes(haystack.slice(0, at)).length;
}
