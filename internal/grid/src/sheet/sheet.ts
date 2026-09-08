// Package sheet holds one table per workspace. It imports nothing from the
// packages above it, which is what lets it be tested with no display attached.
//
// A Sheet is a table held in memory: its source rows, a Schema folded from the
// log, and the rows finished from both as they are read. The engine does the
// same over a file it never holds, with the same Schema and the same pipeline,
// so the rules a test pins here are the rules a 30 GB file follows.

import type { Formula } from "../formula/index.ts";
import { evaluate } from "../formula/index.ts";
import type { Program } from "../program/index.ts";
import { text as programText } from "../program/index.ts";
import type { Edit } from "./edit.ts";
import { NO_ROW, Op } from "./edit.ts";
import type { Kind } from "./kind.ts";
import { inferKind } from "./kind.ts";
import type { Finished } from "./pipeline.ts";
import { finishRows, formatValue } from "./pipeline.ts";
import { Schema } from "./schema.ts";
import type { Written } from "./schema.ts";

/** Column pairs a header with the kind inferred from the values beneath it. */
export interface Column {
  header: string;
  /** Inferred at load; never stored in the file. */
  kind: Kind;
  /**
   * Marks a column that looks numeric but does not parse cleanly, such as one
   * whose thousands separators break half its values. It is the condition the
   * recogniser acts on.
   */
  flagged: boolean;
}

/**
 * FINISH_ROWS is how many rows are finished together when one of them is read:
 * the engine's block size, so a sheet and a file compute formulas in the same
 * steps.
 */
const FINISH_ROWS = 1024;

export class Sheet {
  readonly columns: Column[];
  /** How `ingest` read these bytes, for the status bar to show verbatim. It is
   * an opaque label here on purpose: `ingest` owns the wording, so `sheet` still
   * knows nothing about delimiters or encodings. */
  source = "";

  private readonly rowData: readonly (readonly string[])[];
  private readonly schema: Schema;

  /**
   * Rows finished since the log last changed, indexed by row.
   *
   * `display` runs about two hundred times a frame, so it has to be an array
   * read. The first read of a row after an edit finishes it; every read after
   * that is the lookup.
   */
  private finished: Array<Finished | undefined> = [];

  /**
   * Builds a sheet from a header row and the data rows beneath it, inferring
   * each column's kind as it goes.
   *
   * A row longer than the header contributes no column: the header decides the
   * shape.
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
   * raw is what the cell stores. The log records it, undo restores it, and the
   * recogniser reads it, because all three are about the value a person put
   * there rather than the one they are being shown.
   *
   * An absent cell is empty rather than an error: short rows are normal in real
   * exports, and returning "" is what lets the table skip bounds checks while
   * scrolling.
   */
  raw(row: number, col: number): string {
    if (col < 0) return "";
    return this.row(row)?.raw[col] ?? "";
  }

  /**
   * display is what the cell shows, and what the grid binds to: raw, except
   * where notation or a formula fills the cell in.
   */
  display(row: number, col: number): string {
    if (col < 0) return "";
    return this.row(row)?.shown[col] ?? "";
  }

  /** written is the last write into a cell, or undefined where nobody typed. */
  written(row: number, col: number): Written | undefined {
    return this.schema.writtenIn(row)?.get(col);
  }

  /**
   * row finishes the block a row is in, not the row alone, so that a bound
   * column is computed over the block a column at a time.
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
   * set records a value typed into one cell. It is the only way the grid
   * changes a single value, so the log can never fall behind the data it
   * describes.
   */
  set(row: number, col: number, v: string): void {
    this.record({ seq: 0, op: Op.Set, row, col, was: this.raw(row, col), now: v });
  }

  /**
   * apply runs a program over every value in a column and records it as one
   * operation.
   *
   * It is the door a pattern proposal comes through, and the reason the log
   * stays proportional to what a person did rather than to how much data they
   * did it to: 3,149 cells change and one line is written.
   */
  apply(col: number, p: Program): void {
    this.record({ seq: 0, op: Op.Apply, row: NO_ROW, col, now: programText(p) });
  }

  /**
   * note puts notation in one cell: the person types markdown and the cell
   * shows the symbols it describes.
   *
   * A notation cell stores its source and shows what the source describes,
   * which is the same relationship a bound column has to its expression. It
   * reads no columns and joins no dependency graph, which is everything else.
   */
  note(row: number, col: number, src: string): void {
    this.record({ seq: 0, op: Op.Note, row, col, was: this.raw(row, col), now: src });
  }

  /**
   * bind makes a column derived: what it shows is computed from the columns
   * the expression names. It records one line for a column of any length, and
   * the expression is what the file carries, not the results.
   */
  bind(col: number, f: Formula): void {
    this.record({ seq: 0, op: Op.Bind, row: NO_ROW, col, now: f.toString() });
  }

  /**
   * unbind takes the formula off a column. What it stored before it was bound
   * is what it shows again: binding never removed those values.
   *
   * It is recorded, so it can be undone, and it refuses a column nothing is
   * bound to rather than doing nothing quietly.
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

  /** binding reports the expression a column resolves to. */
  binding(col: number): string | undefined {
    return this.schema.binding(col);
  }

  private record(e: Edit): void {
    this.schema.record(e);
    this.finished = [];
    this.infer();
  }

  /**
   * replay applies a log and keeps it, so that saving a reopened file preserves
   * the history rather than starting a new one. It is linear in the number of
   * operations, not in the rows they touch.
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
   * logEquals reports whether this sheet's log is exactly the one given. It
   * compares rather than counting, because undo makes a count ambiguous.
   */
  logEquals(other: Edit[]): boolean {
    return this.schema.logEquals(other);
  }

  editCount(): number {
    return this.schema.editCount();
  }

  /** edits returns the log to be written, copied. */
  edits(): Edit[] {
    return this.schema.edits();
  }

  // ------------------------------------------------------------ naming

  resolve(name: string): number {
    return this.schema.resolve(name);
  }

  /**
   * evaluateAt computes one row of an expression without binding it, which is
   * what the editor's preview is: an answer to "what would this do", read the
   * way a binding reads the row.
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
   * infer re-reads every column's sample and renames it. A column whose last
   * unparseable value was just fixed is a number column now, and a column that
   * reads it may have become one too.
   */
  private infer(): void {
    for (let col = 0; col < this.columns.length; col++) {
      const { kind, flagged } = inferKind(this.rowData.length, (row) => this.display(row, col));
      const c = this.columns[col]!;
      c.kind = kind;
      c.flagged = flagged;
    }
  }
}
