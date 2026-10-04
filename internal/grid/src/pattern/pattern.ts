// Package pattern induces a transform program from the edits a person made to
// a column, so the app can offer to apply it to the rest.
//
// It reads only the edit log. `propose` returns a question;
// applying the answer is `sheet.apply`.

import { compareStrings, quoteMeta } from "../go/index.ts";
import type { Program } from "../program/index.ts";
import { MAX_STEPS, apply as applyProgram, text as programText } from "../program/index.ts";
import type { Edit, Sheet, Written } from "../sheet/index.ts";
import { Op, settled } from "../sheet/index.ts";
import type { Example } from "./induce.ts";
import {
  decoration,
  droppedChars,
  induce,
  parseAll,
  quoteClass,
  replaceSrc,
  rewrites,
  unionDeletion,
} from "./induce.ts";
import { restructures } from "./restructure.ts";

/** MIN_EXAMPLES is how many changed cells a column needs for a proposal. */
export const MIN_EXAMPLES = 3;

/** SAMPLE_SIZE is the most changes a proposal's preview holds. */
export const SAMPLE_SIZE = 20;

/** MAX_RANKED is the most candidates per reading scored against the column. */
const MAX_RANKED = 32;

/** MAX_FIRST_STEPS is the most dropped characters `compose` will try first. */
const MAX_FIRST_STEPS = 8;

/** One cell a proposal would alter, for the preview to show. */
export interface Change {
  row: number;
  was: string;
  now: string;
}

/**
 * Proposal is the question put to the person: the program, how many cells it
 * would change, and a preview.
 */
export interface Proposal {
  col: number;
  header: string;
  prog: Program;

  /** How many cells would change. The count skips cells already fixed by
   * hand. */
  affects: number;

  sample: Change[];

  /**
   * True when the runner-up candidate gives a different answer somewhere in
   * the column. The offer then leads with the preview.
   */
  ambiguous: boolean;
}

/** One column's worth of a snapshot. */
interface ColumnSnapshot {
  col: number;
  header: string;
  values: string[];
  /** What was typed into each cell, where anything was. */
  written: Array<Written | undefined>;
  examples: Example[];
}

/**
 * Snapshot is a copy of the columns a scan runs over, so the scan can run
 * away from the sheet. Only columns with at least MIN_EXAMPLES examples are
 * copied.
 */
export class Snapshot {
  constructor(private readonly cols: ColumnSnapshot[]) {}

  /** empty reports whether there is anything to scan. */
  empty(): boolean {
    return this.cols.length === 0;
  }

  /**
   * propose returns the first column's proposal, or undefined when every
   * column comes up empty.
   */
  propose(): Proposal | undefined {
    for (const c of this.cols) {
      const s = Survey.start(c.col, c.header, c.examples);
      if (s === undefined) continue;
      s.add(c.values, 0, c.written);
      const p = s.proposal();
      if (p !== undefined) return p;
    }
    return undefined;
  }
}

/** snap copies what `propose` will need from the sheet. */
export function snap(s: Sheet | undefined): Snapshot {
  if (s === undefined) return new Snapshot([]);

  const byCol = gather(s.edits());

  const cols: ColumnSnapshot[] = [];
  for (let col = 0; col < s.cols(); col++) {
    const ex = byCol.get(col);
    if (ex === undefined || ex.length < MIN_EXAMPLES) continue;

    const values: string[] = [];
    const written: Array<Written | undefined> = [];
    for (let row = 0; row < s.rows(); row++) {
      values.push(s.raw(row, col));
      written.push(s.written(row, col));
    }

    cols.push({ col, header: s.columns[col]!.header, values, written, examples: ex });
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
 * Reading is the candidates one witness produced, kept only if they
 * reproduce every example, narrowest first.
 *
 * Candidates that have agreed on every value read so far share a class. Two
 * candidates in different classes differ somewhere in the column, which
 * marks a proposal ambiguous.
 */
interface Reading {
  cands: Candidate[];
  /** The classes with more than one member. */
  classes: number[][];
  classOf: Int32Array;
  nextClass: number;
}

/**
 * Survey scores a column's candidates against its values, a run of rows at a
 * time. `proposal` is correct for the rows read so far. Fed every value at
 * once, it proposes what a whole-column scan does.
 */
export class Survey {
  private seen = 0;

  private constructor(
    readonly col: number,
    readonly header: string,
    private readonly readings: Reading[],
  ) {}

  /**
   * start induces the candidates for a column's examples. Returns undefined
   * when there are too few examples, or when every candidate fails to
   * reproduce them.
   */
  static start(col: number, header: string, examples: Example[]): Survey | undefined {
    if (examples.length < MIN_EXAMPLES) return undefined;

    const readings: Reading[] = [];
    for (const w of WITNESSES) {
      const cands = induce(examples, w.each);
      if (w.together !== undefined) cands.push(...parseAll(w.together(examples)));
      readings.push(reading(examples, cands));
    }
    // Two-step programs are read last. The ranking prefers fewer steps, so
    // they only win for a column that needs two.
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
   * must arrive in row order. `written` is what was typed into each cell,
   * where anything was; a cell a program is already settled over is left as
   * it is.
   */
  add(values: readonly string[], first: number, written: readonly (Written | undefined)[]): void {
    for (let i = 0; i < this.readings.length; i++) {
      const r = this.readings[i]!;
      scan(r, values, first, written);

      // A reading with a candidate that changes a cell outranks every later
      // reading, so the later ones are dropped.
      if (r.cands.some((c) => c.affects > 0)) {
        this.readings.length = i + 1;
        break;
      }
    }
    this.seen += values.length;
  }

  /** proposal returns the question the values read so far support. */
  proposal(): Proposal | undefined {
    for (const r of this.readings) {
      const scored: number[] = [];
      r.cands.forEach((c, i) => {
        // Only candidates that change at least one cell.
        if (c.affects > 0) scored.push(i);
      });
      if (scored.length === 0) continue;

      // Fewest steps, then fewest cells changed, then text order. The
      // narrowest program that still explains every example wins.
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
 * Witness is one way of reading the examples. `each` gives candidates per
 * example, which are intersected. `together` gives candidates from all
 * examples at once, kept as they are.
 */
interface Witness {
  each: (was: string, now: string) => string[];
  together?: (ex: Example[]) => string[];
}

/**
 * The witnesses, tried in order. Rewrites are read first; restructures are
 * used only when every rewrite leaves the column as it is.
 */
const WITNESSES: Witness[] = [{ each: rewrites, together: unionDeletion }, { each: restructures }];

/**
 * compose builds two-step programs: first remove one dropped character (or a
 * class of all of them), then induce a second step from what is left.
 */
function compose(ex: Example[]): Program[] {
  const chars = droppedChars(ex);
  if (chars.length === 0 || chars.length > MAX_FIRST_STEPS) return [];

  const firsts: string[] = chars.map((r) => replaceSrc(quoteMeta(r), ""));
  if (chars.length > 1 && decoration(chars)) {
    firsts.push(replaceSrc("[" + quoteClass(chars) + "]", ""));
  }

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

/**
 * reading keeps the candidates that reproduce every example, deduplicated by
 * text and sorted narrowest first.
 */
function reading(ex: Example[], cands: Program[]): Reading {
  // A candidate that fails an example is dropped. Duplicates are dropped too,
  // so the ambiguity check always compares two different programs.
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
 * scan counts the cells each candidate would change in a run of values and
 * collects the first SAMPLE_SIZE for the preview.
 */
function scan(
  r: Reading,
  values: readonly string[],
  first: number,
  written: readonly (Written | undefined)[],
): void {
  const outs: string[] = [];

  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const w = written[i];
    for (let j = 0; j < r.cands.length; j++) {
      const c = r.cands[j]!;
      // A cell the program is already settled over is left as it is.
      const out = w !== undefined && settled(c.prog, w) ? v : applyProgram(c.prog, v);
      outs[j] = out;
      if (out === v) continue;
      c.affects++;
      if (c.sample.length < SAMPLE_SIZE) c.sample.push({ row: first + i, was: v, now: out });
    }
    if (r.classes.length > 0) split(r, outs);
  }
}

/** split breaks up any class whose members gave different outputs for a value. */
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
    for (const m of members) pushTo(byOut, outs[m]!, m);
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

/** pushTo appends a value to the list under a key, creating the list if needed. */
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const have = m.get(k);
  if (have === undefined) m.set(k, [v]);
  else have.push(v);
}

function bySize(a: Program, b: Program): number {
  const d = a.length - b.length;
  if (d !== 0) return d;
  return compareStrings(programText(a), programText(b));
}

/**
 * gather reads the edit log into examples per column. A cell edited more than
 * once gives one example, from before its first edit to after its last. Edits
 * may sit anywhere in the log. An Apply on a column clears that column's
 * examples.
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
      pushTo(order, e.col, c);
    }
    last.set(c, e.now);
  }

  const out = new Map<number, Example[]>();
  for (const [col, cells] of order) {
    for (const c of cells) {
      const was = first.get(c)!;
      const now = last.get(c)!;
      // A value typed and then typed back counts as unchanged.
      if (was === now) continue;

      pushTo(out, col, { was, now });
    }
  }
  return out;
}
