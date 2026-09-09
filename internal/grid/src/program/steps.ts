// The steps a program is built from.
//
// In Go each is a struct implementing an unexported `run`, which seals the set.
// Here they are a discriminated union, which seals it the same way and lets the
// compiler check that `runStep` covers all of them.

import {
  atoi,
  compile,
  findAllIndex,
  indexOfRunes,
  quote,
  quoteMeta,
  replaceAllLiteral,
  runes,
  toLower,
  toUpper,
  trimSpace,
} from "../go/index.ts";

/**
 * MAX_STEPS bounds a pipeline. The limit is not about cost -- three steps run
 * in microseconds -- but about what a person can be shown in a banner and agree
 * to in one reading. A proposal nobody can check is not a proposal.
 */
export const MAX_STEPS = 3;

/**
 * MAX_PARTS bounds a concat, for the same reason and to the same end: a
 * rearrangement of more than four pieces is not one a banner can put a question
 * about.
 */
export const MAX_PARTS = 4;

// ---------------------------------------------------------------- positions

/**
 * IdxPos counts characters, negative from the end, so slice(0, -1) drops a
 * trailing character whatever the value's length.
 */
export interface IdxPos {
  readonly kind: "idx";
  readonly k: number;
}

/**
 * LenPos is the end of the value, and exists because no index can say it.
 *
 * Counting back from the end gives -1 the character before the last one, which
 * is what a reader of slice(0, -1) expects it to mean, so "as far as it goes"
 * needs a word of its own rather than an off-by-one convention.
 */
export interface LenPos {
  readonly kind: "len";
}

/**
 * MatchPos is the boundary of the k-th match of a pattern, 1-based, and
 * negative from the end.
 *
 * It is what makes a slice generalise: "after the first open bracket" holds
 * across rows where a character count does not.
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
 * resolvePos returns a code-point offset into r, or undefined when the position
 * does not exist in this value -- which is how a slice leaves alone a row that
 * does not look like the rows it was induced from.
 */
function resolvePos(p: Pos, v: string, r: string[]): number | undefined {
  switch (p.kind) {
    case "idx":
      return p.k < 0 ? r.length + p.k : p.k;
    case "len":
      return r.length;
    case "match": {
      // findAllIndex already answers in code points, so there is no byte
      // offset to convert here the way the Go has to.
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

/**
 * ReplaceStep rewrites every occurrence. Every rather than the first, because a
 * value carrying two separators is the case a single-shot replace gets wrong
 * and a person reading a banner would never expect it to.
 */
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

/**
 * SliceStep keeps what lies between two positions. It works in code points
 * rather than bytes: a column of names is as likely to hold é as it is to hold
 * e, and a transform that cuts one in half is worse than no transform.
 */
export interface SliceStep {
  readonly kind: "slice";
  readonly from: Pos;
  readonly to: Pos;
}

/**
 * ConcatStep builds a value out of pieces of the old one and constants between
 * them.
 *
 * It is what a slice on its own cannot do: pulling two fields out of a cell and
 * putting them back in the other order changes no characters, only where they
 * sit, and no amount of replacing expresses that.
 *
 * A part that does not fit abandons the whole step rather than contributing an
 * empty string, because a name reassembled from the half of it that parsed is a
 * worse answer than the name that was already there.
 */
export interface ConcatStep {
  readonly kind: "concat";
  readonly parts: Step[];
}

/**
 * ConstStep is a literal piece of a concat.
 *
 * It is not a step a pipeline can hold on its own: a program that ignores its
 * input and returns a constant would set every cell in a column to the same
 * value, which is a thing to type, not a thing to infer.
 */
export interface ConstStep {
  readonly kind: "const";
  readonly lit: string;
}

export type Step = ReplaceStep | TrimStep | CaseStep | SliceStep | ConcatStep | ConstStep;

/**
 * runStep applies one stage.
 *
 * It reports undefined when the step does not apply to this value -- a slice
 * whose bracket is missing, say. Programs are induced from a handful of rows
 * and then run over thousands, so meeting a value the program was not induced
 * from is ordinary, and it is not an error.
 */
export function runStep(s: Step, v: string): string | undefined {
  switch (s.kind) {
    case "replace":
      // Literally: a replacement is text, not a template. A "$1" in a value
      // someone typed has to survive being written back.
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
  switch (s.kind) {
    case "trim":
      return "trim the spaces off both ends";

    case "case":
      return s.up ? "upper-case it" : "lower-case it";

    case "replace": {
      let what = nameChars(s.src);
      if (what === undefined) {
        const lit = literalOf(s.src);
        if (lit === undefined) return stepText(s);
        what = quote(lit);
      }
      if (s.lit === "") return "remove " + what;
      return `replace ${what} with ${quote(s.lit)}`;
    }

    // A slice, a concat and a constant fall back to the notation. A person
    // asked to approve a rearrangement is better shown a form they can learn
    // than a sentence that glosses over which characters moved where.
    case "slice":
    case "concat":
    case "const":
      return stepText(s);
  }
}

function clamp(i: number, n: number): number {
  return Math.min(Math.max(i, 0), n);
}

/**
 * newReplace builds a substitution step, and is how the synthesiser proposes
 * one without going through the text form.
 */
export function newReplace(src: string, lit: string): ReplaceStep {
  let re: RegExp;
  try {
    re = compile(src);
  } catch (err) {
    throw new Error(`pattern /${src}/: ${(err as Error).message}`);
  }
  return { kind: "replace", re, src, lit };
}

/**
 * quoteRegex renders a pattern back between slashes, escaping the delimiter so
 * a pattern containing one still round-trips.
 */
export function quoteRegex(src: string): string {
  return "/" + src.replaceAll("/", "\\/") + "/";
}

/**
 * charNames is the vocabulary `describe` speaks. It covers the punctuation that
 * turns a number column into a text one, which is the whole of what the
 * recogniser proposes today; anything outside it falls back to the notation.
 */
const CHAR_NAMES = new Map<string, string>(
  Object.entries({
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
  }),
);

const META_CHARS = "\\.+*?()|[]{}^$";

function isMetaChar(c: string): boolean {
  return META_CHARS.includes(c);
}

/**
 * literalOf returns the text a pattern matches, when the pattern is that text
 * and nothing else. It inverts the escaping the deletion lattice applies, and
 * refuses anything it cannot invert exactly.
 */
export function literalOf(src: string): string | undefined {
  let out = "";
  const r = runes(src);
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === "\\") {
      i++;
      if (i >= r.length || !isMetaChar(r[i]!)) return undefined;
      out += r[i]!;
    } else if (isMetaChar(c)) {
      return undefined;
    } else {
      out += c;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * nameChars turns a pattern back into English when it is a plain literal or a
 * plain class of characters this vocabulary knows. Anything with an anchor, a
 * quantifier or a character it cannot name is refused, so `describe` falls back
 * rather than describing a program approximately.
 */
export function nameChars(src: string): string | undefined {
  // The deletion lattice anchors its class rungs. Strip the anchor and say
  // where it pointed, rather than refusing a program the recogniser offers.
  let where = "";
  let body = src;
  if (body.startsWith("^") && body.endsWith("+")) {
    body = body.slice(1, -1);
    where = " from the start";
  } else if (body.endsWith("+$")) {
    body = body.slice(0, -2);
    where = " from the end";
  }

  if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);

  const names: string[] = [];
  const seen = new Set<string>();
  const rs = runes(body);
  for (let i = 0; i < rs.length; i++) {
    let r = rs[i]!;
    if (r === "\\") {
      // A class escapes these four, and they are still one character to a
      // reader. Any other escape -- \d, \s -- is a character set rather than a
      // character, and naming it is the regex engine's job.
      i++;
      if (i >= rs.length || !"]\\^-".includes(rs[i]!)) return undefined;
      r = rs[i]!;
    } else if (r === "^" && i === 0) {
      return undefined; // a negated class means the opposite of what we would say
    }

    const n = CHAR_NAMES.get(r);
    if (n === undefined) return undefined;
    if (!seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }

  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0]! + where;
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1]! + where;
}

export { atoi, indexOfRunes, quoteMeta };
