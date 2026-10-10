// The edit log folded into what a row needs to be finished.
//
// A Schema holds the facts the log adds up to: which cells were written,
// which programs run over each column and in what order, and which columns
// a formula computes. It checks every edit as it is folded.
//
// `pipeline.ts` turns a row of source values and a Schema into the row the
// grid draws. A Sheet does that over rows in memory and the engine over
// pages of a file.

import type { Formula } from "../formula/index.ts";
import { Graph, parse as parseFormula } from "../formula/index.ts";
import { render as renderNotation, supported as notationSupported } from "../notation/index.ts";
import type { Program } from "../program/index.ts";
import { parse as parseProgram } from "../program/index.ts";
import type { Edit } from "./edit.ts";
import { Op, editEquals } from "./edit.ts";

/** The last thing written into one cell. */
export interface Written {
  seq: number;
  /** What the cell stores: the value typed, or the notation's source. */
  now: string;
  /** What a notation cell shows. Undefined for a typed value. */
  rendered?: string;
  /**
   * What the cell held before the run of writes this one continues: the
   * edit's own `was` for the first write since the last apply over the
   * column, and that first write's `was` for any after it. Undefined for
   * notation.
   */
  was?: string;
}

/** A program run over a column by the edit numbered seq. */
export interface Run {
  seq: number;
  prog: Program;
}

/**
 * A column whose values the holder of the rows fills in as it reads them,
 * such as which file a row came from. Its values come from the holder alone,
 * so every edit that names it is refused.
 */
export interface Supplied {
  /** Which column, counting from 0. */
  col: number;
  /** What it shows, used in the message refusing an edit to it. */
  shows: string;
}

export class Schema {
  /** How many rows an edit may name. The holder of the rows keeps it current. */
  rows: number;

  private readonly log: Edit[] = [];
  /** Row, then column, then the last write. Sparse: only cells someone wrote. */
  private readonly written = new Map<number, Map<number, Written>>();
  private readonly runs = new Map<number, Run[]>();
  /** Count of live notation cells per column. A bind over a column that has
   * any is refused. */
  private readonly notation = new Map<number, number>();
  private readonly bound = new Map<number, Formula>();
  private readonly graph = new Graph();
  private computed: number[] = [];
  /** Header to index, or -1 for a header more than one column has. */
  private readonly names = new Map<string, number>();

  constructor(
    readonly headers: readonly string[],
    rows: number,
    /** The column the holder of the rows fills in, if any. It is one of
     * `headers`, so an expression can name it. */
    readonly supplied?: Supplied,
  ) {
    this.rows = rows;
    headers.forEach((h, i) => this.names.set(h, this.names.has(h) ? -1 : i));
  }

  /** of builds a Schema from a saved log. */
  static of(
    headers: readonly string[],
    rows: number,
    edits: readonly Edit[],
    supplied?: Supplied,
  ): Schema {
    const s = new Schema(headers, rows, supplied);
    s.replay(edits);
    return s;
  }

  /**
   * record numbers an edit, checks and folds it, and keeps it. Every check
   * runs before anything changes, so a refused edit leaves the Schema as it
   * was.
   */
  record(e: Edit): Edit {
    e.seq = this.log.length + 1;
    this.fold(e);
    this.log.push(e);
    return e;
  }

  /**
   * replay folds a saved log in, keeping each edit's own `seq`. Each edit is
   * kept as soon as it is folded, so a log refused partway keeps the edits
   * before the refusal.
   */
  replay(edits: readonly Edit[]): void {
    for (const e of edits) {
      this.fold(e);
      this.log.push(e);
    }
  }

  // ------------------------------------------------------------ reading

  /** True when the log is empty. */
  get empty(): boolean {
    return this.log.length === 0;
  }

  writtenIn(row: number): ReadonlyMap<number, Written> | undefined {
    return this.written.get(row);
  }

  runsOver(col: number): readonly Run[] | undefined {
    return this.runs.get(col);
  }

  formula(col: number): Formula | undefined {
    return this.bound.get(col);
  }

  /** The text of the formula bound to a column, if any. */
  binding(col: number): string | undefined {
    return this.bound.get(col)?.toString();
  }

  /** The bound columns, each after the bound columns it reads. */
  computedColumns(): readonly number[] {
    return this.computed;
  }

  /**
   * resolve returns the index of the column with this header. It throws for
   * a header held by zero columns or by more than one.
   */
  resolve(name: string): number {
    const i = this.names.get(name);
    if (i === undefined) throw new Error(`no column is called ${JSON.stringify(name)}`);
    if (i < 0) throw new Error(`more than one column is called ${JSON.stringify(name)}`);
    return i;
  }

  /** indexOf is resolve returning undefined, in place of an error, for a
   * missing or ambiguous name. */
  indexOf(name: string): number | undefined {
    const i = this.names.get(name);
    return i === undefined || i < 0 ? undefined : i;
  }

  editCount(): number {
    return this.log.length;
  }

  /** The log, copied. */
  edits(): Edit[] {
    return this.log.map((e) => ({ ...e }));
  }

  logEquals(other: readonly Edit[]): boolean {
    return this.log.length === other.length && this.log.every((e, i) => editEquals(e, other[i]!));
  }

  // ------------------------------------------------------------ folding

  private fold(e: Edit): void {
    // Every operation names a column.
    const cols = this.headers.length;
    if (e.col < 0 || e.col >= cols) {
      throw new Error(
        `edit ${e.seq}: column ${e.col} is outside the ${cols} columns of this sheet`,
      );
    }
    // A supplied column refuses every operation.
    if (e.col === this.supplied?.col) {
      throw new Error(
        `edit ${e.seq}: ${this.headers[e.col]} shows ${this.supplied.shows}, so it cannot be changed`,
      );
    }

    switch (e.op) {
      case Op.Set:
        this.refuseBound(e, "typed into");
        this.refuseRow(e);
        this.write(e.row, e.col, { seq: e.seq, now: e.now, was: this.firstWas(e) });
        return;

      case Op.Note: {
        this.refuseBound(e, "hold notation");
        // Unsupported notation is refused here, when it is written.
        const bad = notationSupported(e.now);
        if (bad !== undefined) throw new Error(`edit ${e.seq}: ${bad.message}`);
        this.refuseRow(e);
        this.write(e.row, e.col, { seq: e.seq, now: e.now, rendered: renderNotation(e.now) });
        return;
      }

      case Op.Apply: {
        this.refuseBound(e, "rewritten by a program");
        // The Edit holds the program's text. A program that fails to parse
        // is refused before anything changes.
        const prog = atEdit(e, () => parseProgram(e.now));
        const runs = this.runs.get(e.col);
        if (runs === undefined) this.runs.set(e.col, [{ seq: e.seq, prog }]);
        else runs.push({ seq: e.seq, prog });
        return;
      }

      case Op.Bind:
        this.bindColumn(e);
        return;

      case Op.Unbind:
        this.unbindColumn(e);
        return;

      default:
        throw new Error(`edit ${e.seq}: unknown operation ${JSON.stringify(e.op)}`);
    }
  }

  /**
   * refuseBound throws when the column is bound to a formula. `verb`
   * completes the message.
   */
  private refuseBound(e: Edit, verb: string): void {
    if (this.bound.has(e.col)) {
      throw new Error(
        `edit ${e.seq}: ${this.headers[e.col]} is computed by a formula, so its cells cannot be ${verb}`,
      );
    }
  }

  /** refuseRow throws when the row is outside the sheet. */
  private refuseRow(e: Edit): void {
    if (e.row < 0 || e.row >= this.rows) {
      throw new Error(`edit ${e.seq}: row ${e.row} is outside the ${this.rows} rows of this sheet`);
    }
  }

  /**
   * firstWas returns what a set's cell held before the run of writes it
   * continues. If the cell was written since the last apply over its column,
   * that write's `was` is reused. Otherwise it is the edit's own `was`, or
   * "" when it has none.
   */
  private firstWas(e: Edit): string {
    const w = this.written.get(e.row)?.get(e.col);
    const runs = this.runs.get(e.col);
    const applied = runs === undefined ? 0 : runs[runs.length - 1]!.seq;
    if (w?.was !== undefined && w.seq > applied) return w.was;
    return e.was ?? "";
  }

  private write(row: number, col: number, w: Written): void {
    let cells = this.written.get(row);
    if (cells === undefined) {
      cells = new Map();
      this.written.set(row, cells);
    }

    const wasNote = cells.get(col)?.rendered !== undefined;
    const isNote = w.rendered !== undefined;
    if (wasNote !== isNote) {
      this.notation.set(col, (this.notation.get(col) ?? 0) + (isNote ? 1 : -1));
    }
    cells.set(col, w);
  }

  private bindColumn(e: Edit): void {
    const f = atEdit(e, () => parseFormula(e.now));

    // The graph names columns by header, so the header has to name exactly
    // one column.
    const name = atEdit(e, () => this.uniqueHeader(e.col));

    // A column holding notation refuses a bind.
    if (!this.bound.has(e.col) && (this.notation.get(e.col) ?? 0) > 0) {
      throw new Error(
        `edit ${e.seq}: ${name} holds notation, so a formula cannot be bound over it`,
      );
    }

    for (const ref of f.refs()) atEdit(e, () => this.resolve(ref));
    atEdit(e, () => this.graph.bind(name, f));
    this.bound.set(e.col, f);
    this.reorder();
  }

  private unbindColumn(e: Edit): void {
    if (!this.bound.has(e.col)) {
      throw new Error(`edit ${e.seq}: no formula is bound to ${this.headers[e.col]}`);
    }

    const name = atEdit(e, () => this.uniqueHeader(e.col));
    this.bound.delete(e.col);
    this.graph.unbind(name);
    this.reorder();
  }

  private reorder(): void {
    this.computed = this.graph.order().map((name) => this.names.get(name)!);
  }

  private uniqueHeader(col: number): string {
    const name = this.headers[col]!;
    this.resolve(name);
    return name;
  }
}

/**
 * atEdit runs one step of folding an edit and rethrows any error with the
 * edit's number prefixed.
 */
function atEdit<T>(e: Edit, step: () => T): T {
  try {
    return step();
  } catch (err) {
    throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
  }
}
