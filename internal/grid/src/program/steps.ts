// The steps a program is built from, as a discriminated union so the compiler
// checks that `runStep` covers all of them.

import {
  atoi,
  compile,
  findAllIndex,
  indexOfRunes,
  isMeta,
  quote,
  quoteMeta,
  replaceAllLiteral,
  runes,
  toLower,
  toUpper,
  trimSpace,
} from "../go/index.ts";
import { english, englishSought } from "../said/index.ts";
import type { CharName, Sought, StepSaid } from "../said/index.ts";

/**
 * MAX_STEPS is the most steps a pipeline may have. The limit keeps a proposal
 * short enough to read in a banner.
 */
export const MAX_STEPS = 3;

/** MAX_PARTS is the most parts a concat may have, for the same reason. */
export const MAX_PARTS = 4;

// ---------------------------------------------------------------- positions

/**
 * IdxPos is a character index. Negative counts from the end: slice(0, -1)
 * drops the last character.
 */
export interface IdxPos {
  readonly kind: "idx";
  readonly k: number;
}

/**
 * LenPos is the end of the value. -1 is the position before the last
 * character, so the end needs its own form.
 */
export interface LenPos {
  readonly kind: "len";
}

/**
 * MatchPos is the start or end of the k-th match of a pattern. k is 1-based;
 * negative counts from the last match.
 */
export interface MatchPos {
  readonly kind: "match";
  readonly re: RegExp;
  readonly src: string;
  readonly k: number;
  readonly atEnd: boolean;
}

export type Pos = IdxPos | LenPos | MatchPos;

/**
 * resolvePos returns a code-point offset into r, or undefined when the k-th
 * match is missing.
 */
function resolvePos(p: Pos, v: string, r: string[]): number | undefined {
  switch (p.kind) {
    case "idx":
      return p.k < 0 ? r.length + p.k : p.k;
    case "len":
      return r.length;
    case "match": {
      const m = findAllIndex(p.re, v);
      const i = p.k < 0 ? m.length + p.k : p.k - 1;
      if (i < 0 || i >= m.length) return undefined;
      const at = m[i]!;
      return p.atEnd ? at[1] : at[0];
    }
  }
}

export function posText(p: Pos): string {
  switch (p.kind) {
    case "idx":
      return String(p.k);
    case "len":
      return "len";
    case "match":
      return `${p.atEnd ? "end" : "start"}(${quoteRegex(p.src)}, ${p.k})`;
  }
}

// -------------------------------------------------------------------- steps

/** ReplaceStep replaces every match of `re` with `lit`. */
export interface ReplaceStep {
  readonly kind: "replace";
  readonly re: RegExp;
  readonly src: string;
  readonly lit: string;
}

export interface TrimStep {
  readonly kind: "trim";
}

export interface CaseStep {
  readonly kind: "case";
  readonly up: boolean;
}

/** SliceStep keeps the characters between two positions, in code points. */
export interface SliceStep {
  readonly kind: "slice";
  readonly from: Pos;
  readonly to: Pos;
}

/**
 * ConcatStep joins slices of the old value and constants. It applies only
 * when every part does.
 */
export interface ConcatStep {
  readonly kind: "concat";
  readonly parts: Step[];
}

/**
 * ConstStep is a literal piece of a concat. The parser accepts it only inside
 * a concat.
 */
export interface ConstStep {
  readonly kind: "const";
  readonly lit: string;
}

export type Step = ReplaceStep | TrimStep | CaseStep | SliceStep | ConcatStep | ConstStep;

/**
 * runStep applies one step. Returns undefined when the step fails to apply
 * to this value, such as a slice whose match is missing.
 */
export function runStep(s: Step, v: string): string | undefined {
  switch (s.kind) {
    case "replace":
      // The replacement is plain text: "$1" stays "$1".
      return replaceAllLiteral(s.re, v, s.lit);

    case "trim":
      return trimSpace(v);

    case "case":
      return s.up ? toUpper(v) : toLower(v);

    case "slice": {
      const r = runes(v);
      const a = resolvePos(s.from, v, r);
      if (a === undefined) return undefined;
      const b = resolvePos(s.to, v, r);
      if (b === undefined) return undefined;

      const lo = clamp(a, r.length);
      const hi = clamp(b, r.length);
      if (lo >= hi) return "";
      return r.slice(lo, hi).join("");
    }

    case "concat": {
      let out = "";
      for (const p of s.parts) {
        const got = runStep(p, v);
        if (got === undefined) return undefined;
        out += got;
      }
      return out;
    }

    case "const":
      return s.lit;
  }
}

export function stepText(s: Step): string {
  switch (s.kind) {
    case "replace":
      return `replace(${quoteRegex(s.src)}, ${quote(s.lit)})`;
    case "trim":
      return "trim()";
    case "case":
      return s.up ? "upper()" : "lower()";
    case "slice":
      return `slice(${posText(s.from)}, ${posText(s.to)})`;
    case "concat":
      return "concat(" + s.parts.map(stepText).join(", ") + ")";
    case "const":
      return quote(s.lit);
  }
}

export function describeStep(s: Step): string {
  return english({ t: "program", steps: [describedStep(s)] });
}

/** describedStep returns what `describeStep` says, as data. */
export function describedStep(s: Step): StepSaid {
  switch (s.kind) {
    case "trim":
      return { t: "trim" };

    case "case":
      return s.up ? { t: "upper" } : { t: "lower" };

    case "replace": {
      let what: Sought | undefined = soughtChars(s.src);
      if (what === undefined) {
        const lit = literalOf(s.src);
        if (lit === undefined) return { t: "notation", text: stepText(s) };
        what = { t: "literal", text: lit };
      }
      if (s.lit === "") return { t: "remove", what };
      return { t: "replace", what, with: s.lit };
    }

    // A slice, a concat and a constant are shown in program notation.
    case "slice":
    case "concat":
    case "const":
      return { t: "notation", text: stepText(s) };
  }
}

function clamp(i: number, n: number): number {
  return Math.min(Math.max(i, 0), n);
}

/**
 * EVERY_OCCURRENCE is the flag a step's pattern is compiled with. A replace
 * rewrites every match and a match position counts every match. Compiling
 * with "g" saves the regexp shim building a second RegExp per call.
 */
const EVERY_OCCURRENCE = "g";

/**
 * compilePattern compiles a step's pattern. On failure it throws an error
 * naming the pattern.
 */
export function compilePattern(src: string): RegExp {
  try {
    return compile(src, EVERY_OCCURRENCE);
  } catch (err) {
    throw new Error(`pattern /${src}/: ${(err as Error).message}`);
  }
}

/** newReplace builds a replace step from a pattern source and a literal. */
export function newReplace(src: string, lit: string): ReplaceStep {
  return { kind: "replace", re: compilePattern(src), src, lit };
}

/**
 * quoteRegex renders a pattern between slashes, escaping a bare `/`. A `\/`
 * already in the pattern is kept as one escape, since the parser reads `\/`
 * as the delimiter.
 */
export function quoteRegex(src: string): string {
  let out = "/";
  const r = runes(src);
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === "\\" && i + 1 < r.length) {
      const next = r[i + 1]!;
      out += next === "/" ? "\\/" : "\\" + next;
      i++;
    } else if (c === "/") {
      out += "\\/";
    } else {
      out += c;
    }
  }
  return out + "/";
}

/**
 * NAMED maps the characters `describe` can name to their plural names.
 * Anything outside it falls back to notation.
 */
const NAMED: Readonly<Record<string, CharName>> = {
  ",": "commas",
  ".": "full stops",
  $: "dollar signs",
  "£": "pound signs",
  "€": "euro signs",
  "%": "percent signs",
  _: "underscores",
  "'": "apostrophes",
  " ": "spaces",
  "*": "asterisks",
  "#": "hashes",
  "/": "slashes",
  "-": "dashes",
  "+": "plus signs",
  "(": "brackets",
  ")": "brackets",
  '"': "quotes",
  "“": "quotes",
  "”": "quotes",
};

const CHAR_NAMES = new Map<string, CharName>(Object.entries(NAMED));

/**
 * literalOf returns the text a pattern matches when the pattern is only plain
 * characters and escaped META characters. Returns undefined otherwise, or
 * when the text is empty.
 */
export function literalOf(src: string): string | undefined {
  let out = "";
  const r = runes(src);
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === "\\") {
      i++;
      if (i >= r.length || !isMeta(r[i]!)) return undefined;
      out += r[i]!;
    } else if (isMeta(c)) {
      return undefined;
    } else {
      out += c;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * nameChars renders a pattern in English when it is NAMED characters, bare or
 * in a class, with an optional `^[...]+` or `[...]+$` anchor. Returns
 * undefined otherwise.
 */
export function nameChars(src: string): string | undefined {
  const what = soughtChars(src);
  return what === undefined ? undefined : englishSought(what);
}

/**
 * soughtChars returns what `nameChars` says, as data: the characters by name,
 * and where.
 */
export function soughtChars(src: string): Sought | undefined {
  // Strip an anchor and record where it pointed.
  let where: "anywhere" | "start" | "end" = "anywhere";
  let body = src;
  if (body.startsWith("^") && body.endsWith("+")) {
    body = body.slice(1, -1);
    where = "start";
  } else if (body.endsWith("+$")) {
    body = body.slice(0, -2);
    where = "end";
  }

  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);

  const names: CharName[] = [];
  const seen = new Set<CharName>();
  const rs = runes(body);
  for (let i = 0; i < rs.length; i++) {
    let r = rs[i]!;
    if (r === "\\") {
      // A class escapes these four characters. Any other escape (\d, \s) is
      // a set, and is refused.
      i++;
      if (i >= rs.length || !"]\\^-".includes(rs[i]!)) return undefined;
      r = rs[i]!;
    } else if (r === "^" && i === 0) {
      return undefined; // a negated class
    }

    const n = CHAR_NAMES.get(r);
    if (n === undefined) return undefined;
    if (!seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }

  if (names.length === 0) return undefined;
  return { t: "chars", names, where };
}

export { atoi, indexOfRunes, quoteMeta };
