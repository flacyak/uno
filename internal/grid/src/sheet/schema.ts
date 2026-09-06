// The log, folded into what a row needs to be finished.
//
// A Schema holds no rows. It is the edit log read into facts about cells and
// columns: which cells a person typed or wrote notation into, which programs run
// over a column and in what order, and which columns a formula computes. It
// checks every edit the way a sheet always has, in the same words, and it grows
// with what a person did rather than with the file.
//
// `pipeline.ts` turns a row of source values and a Schema into the row the grid
// draws. A Sheet does that over rows in memory and the engine over pages of a
// file, which is how the two follow one set of rules.

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
}

/** A program run over a column by the edit numbered seq. */
export interface Run {
  seq: number;
  prog: Program;
}

export class Schema {
  /** How many rows an edit may name. Whoever holds the rows keeps it current. */
  rows: number;

  private readonly log: Edit[] = [];
  /** Row, then column, then the last write. Sparse: only cells someone wrote. */
  private readonly written = new Map<number, Map<number, Written>>();
  private readonly runs = new Map<number, Run[]>();
  /** Live notation cells per column. A formula may not be bound over one. */
  private readonly notation = new Map<number, number>();
  private readonly bound = new Map<number, Formula>();
  private readonly graph = new Graph();
  private computed: number[] = [];
  /** Header to index, or -1 for a header more than one column has. */
  private readonly names = new Map<string, number>();

  constructor(
    readonly headers: readonly string[],
    rows: number,
  ) {
    this.rows = rows;
    headers.forEach((h, i) => this.names.set(h, this.names.has(h) ? -1 : i));
  }

  /** of builds a Schema from a saved log, which is how undo rebuilds one. */
  static of(headers: readonly string[], rows: number, edits: readonly Edit[]): Schema {
    const s = new Schema(headers, rows);
    s.replay(edits);
    return s;
  }

  /**
   * record checks an edit, numbers it and keeps it. Every check runs before
   * anything changes, so a refused edit leaves the Schema as it was.
   */
  record(e: Edit): Edit {
    e.seq = this.log.length + 1;
    this.fold(e);
    this.log.push(e);
    return e;
  }

  /** replay folds a saved log in, keeping each edit's own number. */
  replay(edits: readonly Edit[]): void {
    for (const e of edits) this.fold(e);
    this.log.push(...edits);
  }

  // ------------------------------------------------------------ reading

  /** No edits, so every row is its source. */
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

  /** The expression a column resolves to. */
  binding(col: number): string | undefined {
    return this.bound.get(col)?.toString();
  }

  /** The bound columns, each after the bound columns it reads. */
  computedColumns(): readonly number[] {
    return this.computed;
  }

  /**
   * resolve names a column the way an expression does. First match wins, and an
   * ambiguous name is a failure rather than a guess: two columns called "total"
   * are a spreadsheet a person can work with and an expression nobody can read.
   */
  resolve(name: string): number {
    const i = this.names.get(name);
    if (i === undefined) throw new Error(`no column is called ${JSON.stringify(name)}`);
    if (i < 0) throw new Error(`more than one column is called ${JSON.stringify(name)}`);
    return i;
  }

  /** resolve without the reasons, for an expression reading a row. */
  indexOf(name: string): number | undefined {
    const i = this.names.get(name);
    return i === undefined || i < 0 ? undefined : i;
  }

  editCount(): number {
    return this.log.length;
  }

  /** The log, copied, because the copy is handed to whatever writes it. */
  edits(): Edit[] {
    return this.log.map((e) => ({ ...e }));
  }

  logEquals(other: readonly Edit[]): boolean {
    return this.log.length === other.length && this.log.every((e, i) => editEquals(e, other[i]!));
  }

  // ------------------------------------------------------------ folding

  private fold(e: Edit): void {
    // Every operation names a column, whatever it does to the rows under it.
    const cols = this.headers.length;
    if (e.col < 0 || e.col >= cols) {
      throw new Error(
        `edit ${e.seq}: column ${e.col} is outside the ${cols} columns of this sheet`,
      );
    }

    switch (e.op) {
      case Op.Set:
        this.refuseBound(e, "typed into");
        this.refuseRow(e);
        this.write(e.row, e.col, { seq: e.seq, now: e.now });
        return;

      case Op.Note: {
        this.refuseBound(e, "hold notation");
        // Checked where the notation is written, so a person finds out while
        // they are still typing rather than finding an empty box later.
        const bad = notationSupported(e.now);
        if (bad !== undefined) throw new Error(`edit ${e.seq}: ${bad.message}`);
        this.refuseRow(e);
        this.write(e.row, e.col, { seq: e.seq, now: e.now, rendered: renderNotation(e.now) });
        return;
      }

      case Op.Apply: {
        // Parsed here rather than carried in the Edit, because an Edit is what a
        // file holds and a file holds text. A log naming a program this build
        // cannot read fails before anything changes.
        let prog: Program;
        try {
          prog = parseProgram(e.now);
        } catch (err) {
          throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
        }
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
   * A derived column has no stored values of its own, so there is nothing in it
   * for a person to write: what they typed would never be what it shows.
   */
  private refuseBound(e: Edit, verb: string): void {
    if (this.bound.has(e.col)) {
      throw new Error(
        `edit ${e.seq}: ${this.headers[e.col]} is computed by a formula, so its cells cannot be ${verb}`,
      );
    }
  }

  /** An out-of-range cell cannot come from the grid, so it means a log that does
   * not belong to these rows. */
  private refuseRow(e: Edit): void {
    if (e.row < 0 || e.row >= this.rows) {
      throw new Error(`edit ${e.seq}: row ${e.row} is outside the ${this.rows} rows of this sheet`);
    }
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
    let f: Formula;
    try {
      f = parseFormula(e.now);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

    // The graph names columns the way a person does, so the column being bound
    // needs a name that means one column.
    let name: string;
    try {
      name = this.uniqueHeader(e.col);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

    // Binding over notation would stop drawing the sources a person wrote,
    // which is a loss they would have to notice rather than be told about.
    if (!this.bound.has(e.col) && (this.notation.get(e.col) ?? 0) > 0) {
      throw new Error(
        `edit ${e.seq}: ${name} holds notation, so a formula cannot be bound over it`,
      );
    }

    for (const ref of f.refs()) {
      try {
        this.resolve(ref);
      } catch (err) {
        throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
      }
    }

    try {
      this.graph.bind(name, f);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }
    this.bound.set(e.col, f);
    this.reorder();
  }

  private unbindColumn(e: Edit): void {
    if (!this.bound.has(e.col)) {
      throw new Error(`edit ${e.seq}: no formula is bound to ${this.headers[e.col]}`);
    }

    let name: string;
    try {
      name = this.uniqueHeader(e.col);
    } catch (err) {
      throw new Error(`edit ${e.seq}: ${(err as Error).message}`);
    }

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
