// Package sheet holds one table per workspace.
//
// A Sheet is a table in memory: its source rows, a Schema folded from the
// log, and rows finished from both as they are read. The engine does the
// same over a file, with the same Schema and the same pipeline.

import type { Formula } from "../formula/index.ts";
import { evaluate } from "../formula/index.ts";
import type { Program } from "../program/index.ts";
import { text as programText } from "../program/index.ts";
import type { Edit } from "./edit.ts";
import { NO_ROW, Op } from "./edit.ts";
import type { Kind } from "./kind.ts";
import { SAMPLE_ROWS, inferKind } from "./kind.ts";
import type { Finished } from "./pipeline.ts";
import { finish, finishRows, formatValue } from "./pipeline.ts";
import { Schema } from "./schema.ts";
import type { Written } from "./schema.ts";

/** Column pairs a header with the kind inferred from its values. */
export interface Column {
  header: string;
  /** Inferred at load; lives in memory only. */
  kind: Kind;
  /**
   * True for a column that would be numeric but for formatting, such as
   * thousands separators. The recogniser acts on it.
   */
  flagged: boolean;
}

/**
 * FINISH_ROWS is how many rows are finished together: the engine's block
 * size, so a sheet and a file compute formulas in the same blocks.
 */
const FINISH_ROWS = 1024;

export class Sheet {
  readonly columns: Column[];
  /** How `ingest` read these bytes, shown verbatim in the status bar. */
  source = "";

  private readonly rowData: readonly (readonly string[])[];
  private readonly schema: Schema;

  /**
   * Rows finished since the log last changed, by row index. A row is
   * finished on its first read after an edit and looked up after that.
   */
  private finished: Array<Finished | undefined> = [];

  /**
   * Builds a sheet from a header row and the data rows under it, and infers
   * each column's kind. The header decides the column count.
   */
  constructor(
    readonly name: string,
    header: string[],
    rows: string[][],
  ) {
    this.rowData = rows;
    this.schema = new Schema(header, rows.length);
    this.columns = header.map((h) => ({ header: h, kind: "text" as Kind, flagged: false }));
    this.infer();
  }

  rows(): number {
    return this.rowData.length;
  }

  cols(): number {
    return this.columns.length;
  }

  /**
   * raw returns what a cell stores. A cell outside the sheet is "".
   */
  raw(row: number, col: number): string {
    if (col < 0) return "";
    return this.row(row)?.raw[col] ?? "";
  }

  /**
   * display returns what a cell shows: raw, except where notation or a
   * formula fills it in. A cell outside the sheet is "".
   */
  display(row: number, col: number): string {
    if (col < 0) return "";
    return this.row(row)?.shown[col] ?? "";
  }

  /** written returns the last write into a cell, or undefined. */
  written(row: number, col: number): Written | undefined {
    return this.schema.writtenIn(row)?.get(col);
  }

  /**
   * row finishes the block the row is in, caches it, and returns the row.
   */
  private row(row: number): Finished | undefined {
    if (row < 0 || row >= this.rowData.length) return undefined;
    const f = this.finished[row];
    if (f !== undefined) return f;

    const first = row - (row % FINISH_ROWS);
    const block = finishRows(this.schema, first, this.rowData.slice(first, first + FINISH_ROWS));
    for (let i = 0; i < block.length; i++) this.finished[first + i] = block[i];
    return block[row - first];
  }

  // ------------------------------------------------------------ the log

  /**
   * set records a value typed into one cell.
   */
  set(row: number, col: number, v: string): void {
    this.record({ seq: 0, op: Op.Set, row, col, was: this.raw(row, col), now: v });
  }

  /**
   * apply records a program run over every value in a column, as one edit.
   */
  apply(col: number, p: Program): void {
    this.record({ seq: 0, op: Op.Apply, row: NO_ROW, col, now: programText(p) });
  }

  /**
   * note records notation in one cell: markdown is stored and the symbols
   * it describes are shown.
   */
  note(row: number, col: number, src: string): void {
    this.record({ seq: 0, op: Op.Note, row, col, was: this.raw(row, col), now: src });
  }

  /**
   * bind records a formula on a column. The column then shows what the
   * expression computes.
   */
  bind(col: number, f: Formula): void {
    this.record({ seq: 0, op: Op.Bind, row: NO_ROW, col, now: f.toString() });
  }

  /**
   * unbind records the removal of a column's formula. The column shows its
   * stored values again. It throws for a column outside the sheet or an
   * unbound one.
   */
  unbind(col: number): void {
    if (col < 0 || col >= this.columns.length) {
      throw new Error(`column ${col} is outside the ${this.columns.length} columns of this sheet`);
    }
    const was = this.binding(col);
    if (was === undefined) {
      throw new Error(`no formula is bound to ${this.columns[col]!.header}`);
    }
    this.record({ seq: 0, op: Op.Unbind, row: NO_ROW, col, was, now: "" });
  }

  /** binding returns the text of the formula bound to a column, if any. */
  binding(col: number): string | undefined {
    return this.schema.binding(col);
  }

  private record(e: Edit): void {
    this.schema.record(e);
    this.settle(e);
  }

  /**
   * settle updates the finished rows and the column kinds after an edit.
   *
   * A set or a note reaches one row. That row is finished again if it was
   * finished, and if the row is within the sample, the kinds of its column
   * and of every computed column are re-read. Any other operation clears
   * every finished row and re-reads every kind.
   */
  private settle(e: Edit): void {
    if (e.op !== Op.Set && e.op !== Op.Note) {
      this.finished = [];
      this.infer();
      return;
    }

    const source = this.rowData[e.row];
    if (source !== undefined && this.finished[e.row] !== undefined) {
      this.finished[e.row] = finish(this.schema, e.row, source);
    }
    if (e.row >= SAMPLE_ROWS) return;

    this.inferColumn(e.col);
    for (const col of this.schema.computedColumns()) this.inferColumn(col);
  }

  /**
   * replay folds a saved log in and keeps it, so a reopened file saves with
   * its history. Finished rows are cleared even when the replay throws.
   */
  replay(edits: Edit[]): void {
    try {
      this.schema.replay(edits);
    } finally {
      this.finished = [];
    }
    this.infer();
  }

  /**
   * logEquals is true when this sheet's log is exactly `other`.
   */
  logEquals(other: Edit[]): boolean {
    return this.schema.logEquals(other);
  }

  editCount(): number {
    return this.schema.editCount();
  }

  /** edits returns the log, copied. */
  edits(): Edit[] {
    return this.schema.edits();
  }

  // ------------------------------------------------------------ naming

  resolve(name: string): number {
    return this.schema.resolve(name);
  }

  /**
   * evaluateAt computes an unbound expression for one row, reading the row
   * as a binding would, and formats the result. It throws when the
   * expression fails on the row.
   */
  evaluateAt(f: Formula, row: number): string {
    const shown = this.row(row)?.shown ?? [];
    return formatValue(
      evaluate(f, {
        value: (name) => {
          const i = this.schema.indexOf(name);
          return i === undefined ? undefined : (shown[i] ?? "");
        },
      }),
    );
  }

  /**
   * infer re-reads every column's sample and sets its kind.
   */
  private infer(): void {
    for (let col = 0; col < this.columns.length; col++) this.inferColumn(col);
  }

  private inferColumn(col: number): void {
    const { kind, flagged } = inferKind(this.rowData.length, (row) => this.display(row, col));
    const c = this.columns[col]!;
    c.kind = kind;
    c.flagged = flagged;
  }
}
