// Ports of Go's regexp package.
//
// RE2 and JavaScript agree on what the induced patterns match. They differ in
// three places this file covers: what a replacement string means, what unit a
// match index is in, and which characters are escaped.

import { MAX_BMP, SURROGATE_PAIR_UNITS, runes } from "./strings.ts";

/**
 * META is the set of characters `regexp.QuoteMeta` escapes. `literalOf` in
 * program/steps.ts inverts it character for character, so the two must match.
 */
export const META = "\\.+*?()|[]{}^$";

export function isMeta(c: string): boolean {
  return META.includes(c);
}

/** quoteMeta mirrors regexp.QuoteMeta. */
export function quoteMeta(s: string): string {
  let out = "";
  for (const r of s) out += isMeta(r) ? "\\" + r : r;
  return out;
}

/**
 * compile mirrors `regexp.Compile`, throwing where Go returns an error. The
 * `u` flag is always added, so the pattern matches code points and an empty
 * match advances by a whole character.
 */
export function compile(src: string, flags = ""): RegExp {
  return new RegExp(src, flags.includes("u") ? flags : flags + "u");
}

function globalize(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

/**
 * replaceAllLiteral mirrors `Regexp.ReplaceAllLiteralString`: replaces every
 * match with `lit` as plain text, with no `$1` expansion. An empty match that
 * starts where the previous match ended is skipped, as in Go.
 */
export function replaceAllLiteral(re: RegExp, s: string, lit: string): string {
  let prevEnd = -1;
  return s.replace(globalize(re), (m: string, ...rest: unknown[]) => {
    const start = matchOffset(rest);
    const abutting = m === "" && start === prevEnd;
    prevEnd = start + m.length;
    return abutting ? "" : lit;
  });
}

/**
 * matchOffset returns the match position from a replacer's arguments. It is
 * the only number among them: captures are strings or undefined, and the
 * subject string and named groups follow it.
 */
function matchOffset(rest: readonly unknown[]): number {
  const at = rest.find((a): a is number => typeof a === "number");
  if (at === undefined) throw new Error("a replacer was called without an offset");
  return at;
}

/**
 * findAllIndex mirrors `Regexp.FindAllStringIndex(s, -1)`, with offsets in
 * code points where Go gives bytes. An empty match right after a previous
 * match is dropped, and the scan advances one character past an empty match.
 */
export function findAllIndex(re: RegExp, s: string): Array<[number, number]> {
  const g = globalize(re);
  g.lastIndex = 0;

  // Code-unit index -> code-point index.
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
      // exec stays put on an empty match; Go advances one rune.
      const here = s.codePointAt(start) ?? 0;
      const next = here > MAX_BMP ? start + SURROGATE_PAIR_UNITS : start + 1;
      if (next > s.length) break;
      g.lastIndex = next;
    }
  }
  return out;
}

/** indexOfRunes mirrors strings.Index, in code-point offsets. -1 when absent. */
export function indexOfRunes(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  if (at < 0) return -1;
  return runes(haystack.slice(0, at)).length;
}
