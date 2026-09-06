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
      const s = Survey.start(c.col, c.header, c.examples);
      if (s === undefined) continue;
      s.add(c.values, 0);
      const p = s.proposal();
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

/** One candidate program, and what it has claimed so far. */
interface Candidate {
  prog: Program;
  text: string;
  affects: number;
  sample: Change[];
}

/**
 * Reading is the candidates one way of reading the examples produced, kept only
 * if they reproduce every example, narrowest first.
 *
 * Candidates that have agreed on every value read so far share a class. Two in
 * different classes part company somewhere in the column, which is what makes a
 * proposal ambiguous, and tracking classes costs a comparison per candidate per
 * value rather than one per pair.
 */
interface Reading {
  cands: Candidate[];
  /** The classes with more than one member. Singletons need no checking. */
  classes: number[][];
  classOf: Int32Array;
  nextClass: number;
}

/**
 * Survey scores a column's candidates against its values, a run of rows at a
 * time.
 *
 * It is what lets the recogniser read a file it never holds. The engine feeds
 * it a block of rows and asks for the proposal as it stands, so a banner can say
 * "at least 18,204 in the first 12M rows" and be right, then say the exact count
 * when the last block has been read. Fed every value at once, it proposes
 * exactly what a whole-column scan does.
 */
export class Survey {
  private seen = 0;

  private constructor(
    readonly col: number,
    readonly header: string,
    private readonly readings: Reading[],
  ) {}

  /**
   * start induces the candidates for a column's examples. Undefined when there
   * are too few examples, or when nothing reproduces them.
   */
  static start(col: number, header: string, examples: Example[]): Survey | undefined {
    if (examples.length < MIN_EXAMPLES) return undefined;

    const readings: Reading[] = [];
    for (const w of WITNESSES) {
      const cands = induce(examples, w.each);
      if (w.together !== undefined) cands.push(...parseAll(w.together(examples)));
      readings.push(reading(examples, cands));
    }
    // Two steps where one will not do, read last. The ranking puts fewer steps
    // first anyway, so this only wins for a column no single step explains.
    readings.push(reading(examples, compose(examples)));

    const kept = readings.filter((r) => r.cands.length > 0);
    return kept.length === 0 ? undefined : new Survey(col, header, kept);
  }

  /** How many values it has read. */
  get rows(): number {
    return this.seen;
  }

  /**
   * add reads the column's values for a run of rows starting at `first`. Runs
   * arrive in row order, so the sample is the first changes in the column rather
   * than the first ones read.
   */
  add(values: readonly string[], first: number): void {
    for (let i = 0; i < this.readings.length; i++) {
      const r = this.readings[i]!;
      scan(r, values, first);

      // A reading with a candidate that claims a cell outranks every reading
      // after it, whatever those go on to find, so they are not read again.
      if (r.cands.some((c) => c.affects > 0)) {
        this.readings.length = i + 1;
        break;
      }
    }
    this.seen += values.length;
  }

  /** proposal is the question the values read so far support. */
  proposal(): Proposal | undefined {
    for (const r of this.readings) {
      const scored: number[] = [];
      r.cands.forEach((c, i) => {
        // It explains the examples and claims nothing else.
        if (c.affects > 0) scored.push(i);
      });
      if (scored.length === 0) continue;

      // Fewest steps, then fewest cells claimed. Preferring the narrowest program
      // that still explains every example is the guard against reading one habit
      // as a licence to rewrite a column: given the choice between "remove the
      // commas" and "remove the commas and the digits", both of which fit, the
      // smaller claim wins.
      scored.sort((a, b) => {
        const A = r.cands[a]!;
        const B = r.cands[b]!;
        const d = A.prog.length - B.prog.length;
        if (d !== 0) return d;
        const n = A.affects - B.affects;
        if (n !== 0) return n;
        return compareStrings(A.text, B.text);
      });

      const top = r.cands[scored[0]!]!;
      return {
        col: this.col,
        header: this.header,
        prog: top.prog,
        affects: top.affects,
        sample: top.sample.slice(),
        ambiguous: scored.length > 1 && r.classOf[scored[0]!] !== r.classOf[scored[1]!],
      };
    }
    return undefined;
  }
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

/** reading keeps the candidates that reproduce the examples, narrowest first. */
function reading(ex: Example[], cands: Program[]): Reading {
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
    if (!seen.has(s) && ex.every((e) => applyProgram(p, e.was) === e.now)) {
      seen.add(s);
      kept.push(p);
    }
  }
  kept.sort(bySize);

  const top = kept.slice(0, MAX_RANKED).map((prog) => ({
    prog,
    text: programText(prog),
    affects: 0,
    sample: [] as Change[],
  }));
  return {
    cands: top,
    classes: top.length > 1 ? [top.map((_, i) => i)] : [],
    classOf: new Int32Array(top.length),
    nextClass: 1,
  };
}

/**
 * scan counts what each candidate would change in a run of values and collects
 * the first few for the preview. A cell a program leaves alone is a cell it
 * does not claim, so the count is exactly the number of cells the person is
 * being asked about.
 */
function scan(r: Reading, values: readonly string[], first: number): void {
  const outs: string[] = [];

  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    for (let j = 0; j < r.cands.length; j++) {
      const c = r.cands[j]!;
      const out = applyProgram(c.prog, v);
      outs[j] = out;
      if (out === v) continue;
      c.affects++;
      if (c.sample.length < SAMPLE_SIZE) c.sample.push({ row: first + i, was: v, now: out });
    }
    if (r.classes.length > 0) split(r, outs);
  }
}

/**
 * split breaks up any class whose members gave different answers for one value.
 * Two spellings of the same transformation are never split, however different
 * they look; two that part company on row 400 are, however similar.
 */
function split(r: Reading, outs: readonly string[]): void {
  let differs = false;
  for (const members of r.classes) {
    const lead = outs[members[0]!];
    for (let m = 1; m < members.length && !differs; m++) differs = outs[members[m]!] !== lead;
    if (differs) break;
  }
  if (!differs) return;

  const next: number[][] = [];
  for (const members of r.classes) {
    const byOut = new Map<string, number[]>();
    for (const m of members) {
      const group = byOut.get(outs[m]!);
      if (group === undefined) byOut.set(outs[m]!, [m]);
      else group.push(m);
    }
    if (byOut.size === 1) {
      next.push(members);
      continue;
    }
    for (const group of byOut.values()) {
      const id = r.nextClass++;
      for (const m of group) r.classOf[m] = id;
      if (group.length > 1) next.push(group);
    }
  }
  r.classes = next;
}

function bySize(a: Program, b: Program): number {
  const d = a.length - b.length;
  if (d !== 0) return d;
  return compareStrings(programText(a), programText(b));
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
export function gather(log: readonly Edit[]): Map<number, Example[]> {
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
