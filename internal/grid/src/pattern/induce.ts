import {
  compareStrings,
  equalFold,
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

/** One demonstrated change: what a cell held before the person touched it, and
 * what they left in it. */
export interface Example {
  was: string;
  now: string;
}

/**
 * maxPerExample bounds how many programs one example may suggest.
 *
 * The bound matters because the candidate sets are intersected: a wide set
 * costs its width once per example, and the intersection is what narrows it,
 * not the generator.
 */
export const MAX_PER_EXAMPLE = 256;

/**
 * induce is the synthesiser. It asks each example what programs could have
 * produced it, then keeps only the programs every example agrees on.
 *
 * This is a version space, intersected: the candidate set for one example is
 * every program in the language consistent with it, and the answer is the
 * intersection across all of them. The set is enumerated rather than held
 * symbolically, which is what keeps this a few hundred lines instead of a few
 * thousand -- the lattice each witness draws from is deliberately small, so a
 * finite list is the whole space rather than a sample of it.
 *
 * A fourth example can only ever shrink the result. That is the property the
 * whole design leans on: watching someone work never makes the guess worse.
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
 * parseAll turns the generated text into programs. A candidate that does not
 * parse is a bug in a witness function, and it is dropped rather than raised:
 * the tests are where that is caught, and a person editing a spreadsheet should
 * not be shown a dialog about it.
 */
export function parseAll(srcs: string[]): Program[] {
  const out: Program[] = [];
  for (const s of srcs) {
    try {
      out.push(parseProgram(s));
    } catch {
      // dropped on purpose; see above
    }
  }
  return out;
}

function dedup(input: string[]): string[] {
  const seen = new Set<string>();
  let out: string[] = [];
  for (const s of input) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  if (out.length > MAX_PER_EXAMPLE) {
    out.sort(compareStrings);
    out = out.slice(0, MAX_PER_EXAMPLE);
  }
  return out;
}

/**
 * rewrites induces the programs that change characters where they stand: the
 * deletions, the substitutions and the case changes.
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
 * deletions generalises "these stretches went away".
 *
 * The lattice is four rungs: the exact text, the class of characters it is made
 * of, and each of those anchored to the end the deletions actually sat at. It
 * climbs from specific to general so that ranking can prefer the narrowest
 * program that still explains every example, which is the guard against reading
 * one habit as a licence to rewrite a whole column.
 */
function deletions(a: string[], dels: Run[]): string[] {
  const out: string[] = [];
  const texts = new Set<string>();
  const chars: string[] = [];
  const seen = new Set<string>();

  let prefix = true;
  let suffix = true;
  let spaces = true;
  let edges = true; // every run touches an end, not necessarily the same one

  for (const d of dels) {
    texts.add(d.text);
    for (const r of d.text) {
      if (!seen.has(r)) {
        seen.add(r);
        chars.push(r);
      }
      if (!isSpace(r)) spaces = false;
    }
    const head = d.at === 0;
    const tail = d.at + runes(d.text).length === a.length;
    if (!head) prefix = false;
    if (!tail) suffix = false;
    if (!head && !tail) edges = false;
  }
  if (chars.length === 0) return [];
  chars.sort(compareStrings);

  if (texts.size === 1) {
    for (const t of texts) out.push(replaceSrc(quoteMeta(t), ""));
  }

  const cls = "[" + quoteClass(chars) + "]";
  out.push(replaceSrc(cls, ""));
  if (suffix) out.push(replaceSrc(cls + "+$", ""));
  if (prefix) out.push(replaceSrc("^" + cls + "+", ""));

  // Both ends at once is the ordinary case and neither anchor covers it, so
  // trim asks about the ends rather than about the anchor they share.
  if (spaces && edges) out.push("trim()");
  return out;
}

/**
 * substitutions generalises "this stretch became that one", once or many times.
 *
 * Many times only when it is the same stretch becoming the same thing, which is
 * one rule the person applied more than once: 2026/09/03 has two slashes and
 * one rule, and a value where two different stretches changed has no single
 * rule in it to find.
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
 * droppedChars is every character the examples lost, across all of them.
 *
 * Insertions are ignored: a caller wanting a whole transformation checks that,
 * a caller wanting a first step does not.
 */
export function droppedChars(ex: Example[]): string[] {
  const chars: string[] = [];
  const seen = new Set<string>();

  for (const e of ex) {
    const a = runes(e.was);
    const b = runes(e.now);
    if (a.length > MAX_DIFF || b.length > MAX_DIFF) return [];

    const al = align(a, b);
    if (al === undefined) return [];
    for (const d of al.dels) {
      for (const r of d.text) {
        if (!seen.has(r)) {
          seen.add(r);
          chars.push(r);
        }
      }
    }
  }
  chars.sort(compareStrings);
  return chars;
}

/**
 * unionDeletion is droppedChars as a candidate, for the columns whose
 * decoration only some rows wear: $1,204 offers [$,] and $87 offers [$], the
 * intersection of those two is empty, and [$,] is what both meant.
 *
 * This is the one reading that is not intersected, so it is offered rather than
 * concluded: `explains` decides whether it stands.
 */
export function unionDeletion(ex: Example[]): string[] {
  for (const e of ex) {
    const al = align(runes(e.was), runes(e.now));
    if (al === undefined || al.ins.length > 0) return [];
  }
  const chars = droppedChars(ex);
  if (chars.length === 0) return [];
  return [replaceSrc("[" + quoteClass(chars) + "]", "")];
}

export function replaceSrc(re: string, lit: string): string {
  return "replace(" + quoteRegex(re) + ", " + quote(lit) + ")";
}

/**
 * quoteClass escapes what a character class treats specially. The characters
 * this matters for -- the separators, the currency marks -- are exactly the
 * ones the recogniser exists to remove.
 */
export function quoteClass(rs: string[]): string {
  let out = "";
  for (const r of rs) {
    if ("]\\^-".includes(r)) out += "\\";
    out += r;
  }
  return out;
}
