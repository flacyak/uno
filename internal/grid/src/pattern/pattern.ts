// Package pattern watches what someone has already done to a column and works
// out what they meant, so the app can offer to do the rest.
//
// It observes the edit log and nothing else. The log is the record of what was
// done, the format a workspace is saved in, and the examples this module learns
// from, all at once -- which is why a recogniser needs no channel of its own and
// no state that could fall out of step with the data.
//
// Nothing here decides anything. `propose` returns a question; applying the
// answer is `sheet.apply`, and only a person reaches it.

import { compareStrings, quoteMeta } from "../go/index.ts";
import type { Program } from "../program/index.ts";
import { MAX_STEPS, apply as applyProgram, text as programText } from "../program/index.ts";
import type { Edit, Sheet } from "../sheet/index.ts";
import { Op } from "../sheet/index.ts";
import type { Example } from "./induce.ts";
import {
  droppedChars,
  induce,
  parseAll,
  quoteClass,
  replaceSrc,
  rewrites,
  unionDeletion,
} from "./induce.ts";
import { restructures } from "./restructure.ts";

/**
 * MIN_EXAMPLES is how many consistent changes make a question worth asking. Two
 * is a coincidence often enough to be annoying; the third is the one that says
 * this is a habit and not a typo.
 */
export const MIN_EXAMPLES = 3;

/** SAMPLE_SIZE bounds the preview. Twenty rows is more than anyone reads and
 * few enough to build without measuring. */
export const SAMPLE_SIZE = 20;

/**
 * maxRanked bounds the programs that get scored against the whole column.
 * Scoring is the only part of this that touches every row, and the candidates
 * past the first few dozen are refinements of each other.
 */
const MAX_RANKED = 32;

/** maxFirstSteps bounds the fan-out. Each candidate costs a full induction over
 * every example. */
const MAX_FIRST_STEPS = 8;

/** One cell a proposal would alter, for the preview to show. */
export interface Change {
  row: number;
  was: string;
  now: string;
}

/**
 * Proposal is the question. It carries what it would do and how much of it,
 * because a person cannot agree to a transformation they have only been told
 * the name of.
 */
export interface Proposal {
  col: number;
  header: string;
  prog: Program;

  /**
   * How many cells would change, not counting the ones already fixed by hand --
   * those are the examples, and offering to redo them would be counting the
   * person's own work as the app's.
   */
  affects: number;

  sample: Change[];

  /**
   * Marks a proposal whose runner-up disagrees with it somewhere in the column.
   *
   * The examples do not settle which was meant, so the offer leads with the
   * preview rather than with the button: a guess that says it is a guess is
   * worth making, and one that does not is not.
   */
  ambiguous: boolean;
}

/** One column's worth of a snapshot. */
interface ColumnSnapshot {
  col: number;
  header: string;
  values: string[];
  examples: Example[];
}

/**
 * Snapshot is the copy a scan runs over. The values are taken where the sheet
 * lives and the scan can then happen anywhere, because counting matches across
 * a few thousand rows is felt in a scroll.
 *
 * Only columns with enough examples to ask about are copied, so a snapshot
 * taken after an ordinary edit is usually empty and costs nothing.
 */
export class Snapshot {
  constructor(private readonly cols: ColumnSnapshot[]) {}

  /** Whether there is anything to scan, so a caller can skip starting work that
   * would have nothing to do. */
  empty(): boolean {
    return this.cols.length === 0;
  }

  /**
   * propose returns the strongest question the snapshot supports, or undefined
   * for none.
   *
   * One at a time: a person asked two questions about their spreadsheet at once
   * answers neither.
   */
  propose(): Proposal | undefined {
    for (const c of this.cols) {
      const p = proposeColumn(c);
      if (p !== undefined) return p;
    }
    return undefined;
  }
}

/** snap copies what `propose` will need. */
export function snap(s: Sheet | undefined): Snapshot {
  if (s === undefined) return new Snapshot([]);

  const byCol = gather(s.edits());

  const cols: ColumnSnapshot[] = [];
  for (let col = 0; col < s.cols(); col++) {
    const ex = byCol.get(col);
    if (ex === undefined || ex.length < MIN_EXAMPLES) continue;

    const values: string[] = [];
    for (let row = 0; row < s.rows(); row++) values.push(s.raw(row, col));

    cols.push({ col, header: s.columns[col]!.header, values, examples: ex });
  }
  return new Snapshot(cols);
}

/**
 * witness is the two ways to read a set of examples: one at a time, whose
 * candidate sets are intersected, and all at once, whose candidates are not.
 *
 * Intersecting asks what the examples have in common, which is the right
 * question and the whole of the design -- but a column whose decoration only
 * some rows wear has its answer in their union instead.
 */
interface Witness {
  each: (was: string, now: string) => string[];
  together?: (ex: Example[]) => string[];
}

/**
 * The witnesses, tried in order, and the first that yields a proposal for this
 * column wins.
 *
 * The order is the point. Rewrites and restructurings are different readings of
 * the same edit -- deleting the separators from 1,204 and slicing four
 * characters out of it agree on that row and on nothing after it -- and a
 * column where characters changed is almost always a column where characters
 * were meant to change. Falling back a whole column at a time rather than a
 * single example at a time is what keeps one reading from answering for the
 * other.
 */
const WITNESSES: Witness[] = [{ each: rewrites, together: unionDeletion }, { each: restructures }];

function proposeColumn(c: ColumnSnapshot): Proposal | undefined {
  for (const w of WITNESSES) {
    const cands = induce(c.examples, w.each);
    if (w.together !== undefined) cands.push(...parseAll(w.together(c.examples)));
    const p = rank(c, cands);
    if (p !== undefined) return p;
  }
  // Two steps where one will not do. The ranking comparator sorts by step count
  // first, so a one-step program keeps its precedence and this is only ever
  // reached by a column no single step explains.
  return rank(c, compose(c.examples));
}

/**
 * compose builds the two-step programs, by clearing characters first and
 * reading what is left second.
 *
 * The first step comes from the characters the examples lost rather than from a
 * lattice that has to explain them, and what it leaves is a shape the second
 * step reads the same way in every row: (1,204) and (87) have no decomposition
 * in common until the comma is gone, and 1.204,50 and 9.870,25 have no
 * substitution in common until the full stop is.
 */
function compose(ex: Example[]): Program[] {
  const chars = droppedChars(ex);
  if (chars.length === 0 || chars.length > MAX_FIRST_STEPS) return [];

  const firsts: string[] = chars.map((r) => replaceSrc(quoteMeta(r), ""));
  if (chars.length > 1) firsts.push(replaceSrc("[" + quoteClass(chars) + "]", ""));

  const out: Program[] = [];
  for (const first of parseAll(firsts)) {
    const rest: Example[] = ex.map((e) => ({ was: applyProgram(first, e.was), now: e.now }));
    for (const w of WITNESSES) {
      for (const second of induce(rest, w.each)) {
        if (first.length + second.length > MAX_STEPS) continue;
        out.push([...first, ...second]);
      }
    }
  }
  return out;
}

/** rank keeps the candidates that reproduce the examples and returns the best
 * of them as the question to ask. */
function rank(c: ColumnSnapshot, cands: Program[]): Proposal | undefined {
  // Verification is separate from induction on purpose. A witness function that
  // generalises too far is a bug that shows up here as a candidate that does
  // not reproduce an example, and it is dropped rather than ranked down: a
  // program that cannot reproduce what it was induced from has no claim on
  // anything else in the column.
  //
  // The two readings can land on the same program, and a duplicate at the top
  // of the ranking would compare a program with itself and report a column
  // unambiguous that is not.
  const kept: Program[] = [];
  const seen = new Set<string>();
  for (const p of cands) {
    const s = programText(p);
    if (!seen.has(s) && explains(c, p)) {
      seen.add(s);
      kept.push(p);
    }
  }
  if (kept.length === 0) return undefined;

  kept.sort(bySize);
  const scored: Array<{ p: Program; n: number; s: Change[] }> = [];
  for (const p of kept.slice(0, MAX_RANKED)) {
    const [n, sample] = survey(p, c.values);
    if (n === 0) continue; // it explains the examples and claims nothing else
    scored.push({ p, n, s: sample });
  }
  if (scored.length === 0) return undefined;

  // Fewest steps, then fewest cells claimed. Preferring the narrowest program
  // that still explains every example is the guard against reading one habit as
  // a licence to rewrite a column: given the choice between "remove the commas"
  // and "remove the commas and the digits", both of which fit, the smaller
  // claim wins.
  scored.sort((a, b) => {
    const d = a.p.length - b.p.length;
    if (d !== 0) return d;
    const n = a.n - b.n;
    if (n !== 0) return n;
    return compareStrings(programText(a.p), programText(b.p));
  });

  const top = scored[0]!;
  return {
    col: c.col,
    header: c.header,
    prog: top.p,
    affects: top.n,
    sample: top.s,
    ambiguous: scored.length > 1 && disagree(c, top.p, scored[1]!.p),
  };
}

function explains(c: ColumnSnapshot, p: Program): boolean {
  return c.examples.every((e) => applyProgram(p, e.was) === e.now);
}

/**
 * disagree reports whether two programs would do different things anywhere in
 * this column.
 *
 * Two spellings of the same transformation are not an ambiguity, however
 * different they look; two transformations that part company on row 400 are,
 * however similar.
 */
function disagree(c: ColumnSnapshot, a: Program, b: Program): boolean {
  return c.values.some((v) => applyProgram(a, v) !== applyProgram(b, v));
}

function bySize(a: Program, b: Program): number {
  const d = a.length - b.length;
  if (d !== 0) return d;
  return compareStrings(programText(a), programText(b));
}

/**
 * survey counts what a program would change and collects the first few for the
 * preview. A cell the program leaves alone is a cell it does not claim, so the
 * count is exactly the number of cells the person is being asked about.
 */
function survey(p: Program, values: string[]): [number, Change[]] {
  let n = 0;
  const sample: Change[] = [];

  for (let row = 0; row < values.length; row++) {
    const v = values[row]!;
    const out = applyProgram(p, v);
    if (out === v) continue;
    n++;
    if (sample.length < SAMPLE_SIZE) sample.push({ row, was: v, now: out });
  }
  return [n, sample];
}

/**
 * gather reads the log back into the changes it describes.
 *
 * A cell edited twice contributes one example, from what it held before the
 * first edit to what it holds after the last: the net change is what was meant,
 * and the intermediate value was a keystroke. Edits need not be adjacent in the
 * log -- someone fixing a column will wander off to another one and come back,
 * and a recogniser that only reads the tail would never see the pattern.
 *
 * An apply on a column clears its examples. The values those edits recorded no
 * longer exist, and generalising from them again would be inducing a rule from
 * the results of a rule.
 */
function gather(log: Edit[]): Map<number, Example[]> {
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const order = new Map<number, string[]>();

  const key = (row: number, col: number): string => `${row}:${col}`;

  for (const e of log) {
    if (e.op === Op.Apply) {
      for (const c of order.get(e.col) ?? []) {
        first.delete(c);
        last.delete(c);
      }
      order.delete(e.col);
      continue;
    }
    if (e.op !== Op.Set) continue;

    const c = key(e.row, e.col);
    if (!first.has(c)) {
      first.set(c, e.was ?? "");
      const cells = order.get(e.col);
      if (cells === undefined) order.set(e.col, [c]);
      else cells.push(c);
    }
    last.set(c, e.now);
  }

  const out = new Map<number, Example[]>();
  for (const [col, cells] of order) {
    for (const c of cells) {
      const was = first.get(c)!;
      const now = last.get(c)!;
      // A value typed and then typed back is not a demonstration.
      if (was === now) continue;

      const have = out.get(col);
      if (have === undefined) out.set(col, [{ was, now }]);
      else have.push({ was, now });
    }
  }
  return out;
}
