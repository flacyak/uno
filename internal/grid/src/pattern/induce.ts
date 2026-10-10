import {
  compareStrings,
  equalFold,
  isDigit,
  isLetter,
  isSpace,
  quote,
  quoteMeta,
  runes,
  toLower,
  toUpper,
  trimSpace,
} from "../go/index.ts";
import type { Program } from "../program/index.ts";
import { parse as parseProgram, quoteRegex } from "../program/index.ts";
import type { Run } from "./align.ts";
import { MAX_DIFF, align } from "./align.ts";

/** One demonstrated change: what a cell held before and after the person
 * edited it. */
export interface Example {
  was: string;
  now: string;
}

/** MAX_PER_EXAMPLE is the most candidate programs one example may suggest. */
export const MAX_PER_EXAMPLE = 256;

/**
 * induce asks `witness` for the candidate programs of each example, then
 * keeps only the candidates every example shares. Returns them parsed, in
 * sorted order. Adding an example can only shrink the result.
 */
export function induce(ex: Example[], witness: (was: string, now: string) => string[]): Program[] {
  if (ex.length === 0) return [];

  let keep = dedup(witness(ex[0]!.was, ex[0]!.now));
  for (const e of ex.slice(1)) {
    keep = intersect(keep, dedup(witness(e.was, e.now)));
    if (keep.length === 0) return [];
  }

  keep.sort(compareStrings);
  return parseAll(keep);
}

function intersect(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  return a.filter((s) => inB.has(s));
}

/**
 * parseAll parses candidate text into programs. A candidate that fails to
 * parse is dropped.
 */
export function parseAll(srcs: string[]): Program[] {
  const out: Program[] = [];
  for (const s of srcs) {
    try {
      out.push(parseProgram(s));
    } catch {
      // a candidate that fails to parse is dropped
    }
  }
  return out;
}

/**
 * dedup keeps each candidate once, in first-seen order, and at most
 * MAX_PER_EXAMPLE of them.
 */
function dedup(input: string[]): string[] {
  const out = [...new Set(input)];
  return out.length > MAX_PER_EXAMPLE ? out.sort(compareStrings).slice(0, MAX_PER_EXAMPLE) : out;
}

/**
 * rewrites induces the programs that change characters in place: case
 * changes, deletions and substitutions.
 */
export function rewrites(was: string, now: string): string[] {
  if (was === now) return [];

  const out: string[] = [];
  if (equalFold(was, now)) {
    if (now === toUpper(was)) out.push("upper()");
    if (now === toLower(was)) out.push("lower()");
  }

  const a = runes(was);
  const b = runes(now);
  const al = align(a, b);
  if (al === undefined) return out;

  if (al.dels.length > 0 && al.ins.length === 0) {
    out.push(...deletions(a, al.dels));
  } else if (al.dels.length === al.ins.length && al.dels.length > 0) {
    out.push(...substitutions(al.dels, al.ins));
  }
  return out;
}

/**
 * deletions generalises the removed runs into candidates: the exact text when
 * every run is the same, a character class of the removed characters, and
 * that class anchored to the start or the end where every run sat there.
 * Class candidates are built only from decoration.
 * `trim()` is added when every run is whitespace touching an end.
 */
function deletions(a: string[], dels: Run[]): string[] {
  const out: string[] = [];
  const texts = new Set<string>();
  const dropped = new Set<string>();

  let prefix = true;
  let suffix = true;
  let spaces = true;
  let edges = true; // every run touches the start or the end

  for (const d of dels) {
    texts.add(d.text);
    for (const r of d.text) {
      dropped.add(r);
      if (!isSpace(r)) spaces = false;
    }
    const head = d.at === 0;
    const tail = d.at + runes(d.text).length === a.length;
    if (!head) prefix = false;
    if (!tail) suffix = false;
    if (!head && !tail) edges = false;
  }
  if (dropped.size === 0) return [];
  const chars = [...dropped].sort(compareStrings);

  if (texts.size === 1) {
    for (const t of texts) out.push(replaceSrc(quoteMeta(t), ""));
  }

  if (decoration(chars)) {
    const cls = "[" + quoteClass(chars) + "]";
    out.push(replaceSrc(cls, ""));
    if (suffix) out.push(replaceSrc(cls + "+$", ""));
    if (prefix) out.push(replaceSrc("^" + cls + "+", ""));
  }

  // Space removed at both ends is trim's case: each anchor wants one end.
  if (spaces && edges) out.push("trim()");
  return out;
}

/**
 * substitutions generalises "this run became that one". It applies only when
 * every removed run is the same text and every inserted run is the same
 * text. Candidates: the exact text, a class of its characters, and `\s+`
 * when it is all whitespace.
 */
function substitutions(dels: Run[], ins: Run[]): string[] {
  const d = dels[0]!;
  const i = ins[0]!;
  for (const r of dels.slice(1)) if (r.text !== d.text) return [];
  for (const r of ins.slice(1)) if (r.text !== i.text) return [];

  const out = [replaceSrc(quoteMeta(d.text), i.text)];

  const chars = [...new Set(runes(d.text))].sort(compareStrings);
  out.push(replaceSrc("[" + quoteClass(chars) + "]+", i.text));

  if (trimSpace(d.text) === "") out.push(replaceSrc("\\s+", i.text));
  return out;
}

/**
 * droppedChars is every character removed across all examples, sorted.
 * Insertions are ignored. Returns [] if any example is too long to align.
 */
export function droppedChars(ex: Example[]): string[] {
  const chars = new Set<string>();
  for (const e of ex) {
    const a = runes(e.was);
    const b = runes(e.now);
    if (a.length > MAX_DIFF || b.length > MAX_DIFF) return [];

    const al = align(a, b);
    if (al === undefined) return [];
    for (const d of al.dels) for (const r of d.text) chars.add(r);
  }
  return [...chars].sort(compareStrings);
}

/**
 * unionDeletion is one candidate that removes every dropped character as a
 * class, for columns where only some rows wear the decoration: $1,204 and $87
 * share [$,]. Returns [] when any example has an insertion, or when a dropped
 * character is a letter or digit.
 */
export function unionDeletion(ex: Example[]): string[] {
  for (const e of ex) {
    const al = align(runes(e.was), runes(e.now));
    if (al === undefined || al.ins.length > 0) return [];
  }
  const chars = droppedChars(ex);
  if (chars.length === 0 || !decoration(chars)) return [];
  return [replaceSrc("[" + quoteClass(chars) + "]", "")];
}

/**
 * decoration reports whether every character is punctuation, a symbol or
 * space.
 */
export function decoration(chars: readonly string[]): boolean {
  return chars.every((r) => !isLetter(r) && !isDigit(r));
}

export function replaceSrc(re: string, lit: string): string {
  return "replace(" + quoteRegex(re) + ", " + quote(lit) + ")";
}

/** quoteClass escapes `]`, `\`, `^` and `-` for use inside a character class. */
export function quoteClass(rs: string[]): string {
  let out = "";
  for (const r of rs) {
    if ("]\\^-".includes(r)) out += "\\";
    out += r;
  }
  return out;
}
