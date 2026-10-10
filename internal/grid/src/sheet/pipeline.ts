// Finishing a row: its source values with the log applied.
//
// Every operation in the log reads one row, so rows can be finished in any
// order and each call starts fresh. A formula is computed a column at a time
// over the block of rows being finished.

import { formatFloat, roundSignificant } from "../go/index.ts";
import type { Columns } from "../formula/index.ts";
import { evaluateColumn } from "../formula/index.ts";
import { apply as applyProgram } from "../program/index.ts";
import type { Program } from "../program/index.ts";
import type { Schema, Written } from "./schema.ts";

/**
 * ERR_CELL is what a bound column shows where its expression failed on a
 * row. The reason is shown in the editor.
 */
export const ERR_CELL = "#ERR";

/**
 * SHOWN_DIGITS is how many significant digits a computed cell keeps: the
 * fifteen a float64 carries exactly.
 */
const SHOWN_DIGITS = 15;

/**
 * formatValue renders a computed number: rounded to SHOWN_DIGITS, which
 * drops binary artefacts like 0.21999999999999997, then written in plain
 * notation.
 */
export function formatValue(v: number): string {
  return formatFloat(roundSignificant(v, SHOWN_DIGITS));
}

/** A row with the log applied. */
export interface Finished {
  /** What each cell stores. The log, undo and the recogniser read this. */
  raw: readonly string[];
  /** What the grid draws: raw, except where notation or a formula fills a cell. */
  shown: readonly string[];
}

/**
 * valueAt returns what one cell stores: the last value written into it, or
 * else its source value, with every program recorded on the column after
 * that value run over it. A program is skipped for a written cell it is
 * `settled` over.
 */
export function valueAt(
  schema: Schema,
  row: number,
  col: number,
  source: readonly string[],
): string {
  return stored(schema, col, schema.writtenIn(row)?.get(col), source);
}

function stored(
  schema: Schema,
  col: number,
  w: Written | undefined,
  source: readonly string[],
): string {
  const runs = schema.runsOver(col);

  if (w === undefined) {
    // A short row ends before this column, so the cell is "" as it stands.
    if (col >= source.length) return "";
    let v = source[col]!;
    if (runs !== undefined) for (const r of runs) v = applyProgram(r.prog, v);
    return v;
  }

  let v = w.now;
  if (runs !== undefined) {
    for (const r of runs) if (r.seq > w.seq && !settled(r.prog, w)) v = applyProgram(r.prog, v);
  }
  return v;
}

/**
 * settled is true when running `prog` over what the cell held before it was
 * written gives what was written. Such a cell is one the program was learned
 * from, so an apply leaves it alone and the recogniser skips it.
 */
export function settled(prog: Program, w: Pick<Written, "was" | "now">): boolean {
  return w.was !== undefined && applyProgram(prog, w.was) === w.now;
}

/**
 * finish applies the log to one source row.
 */
export function finish(schema: Schema, row: number, source: readonly string[]): Finished {
  return finishRows(schema, row, [source])[0]!;
}

/**
 * finishRows applies the log to a block of source rows starting at row
 * `first`. Everything but formulas is applied a row at a time. Formulas are
 * then computed a column at a time over the block, in dependency order.
 *
 * With an empty log and a schema whose `supplied` is undefined, each row is
 * returned as the source array itself.
 *
 * `supplied` holds the value of the schema's supplied column for each row of
 * the block. It is written into the finished row, and a formula that names
 * the column reads it there. A schema with a supplied column copies every
 * row.
 */
export function finishRows(
  schema: Schema,
  first: number,
  sources: readonly (readonly string[])[],
  supplied?: readonly string[],
): Finished[] {
  if (schema.empty && schema.supplied === undefined) {
    return sources.map((source) => ({ raw: source, shown: source }));
  }

  const order = schema.computedColumns();
  const out = sources.map((source, i) =>
    finishCells(schema, first + i, source, order.length > 0, supplied?.[i] ?? ""),
  );
  if (order.length === 0 || out.length === 0) return out;

  // A formula reads what a cell shows. Bound columns are computed in
  // dependency order, so a column that reads another bound column reads what
  // that column computed.
  const shown = out.map((f) => f.shown as string[]);
  const columns: Columns = {
    column(name) {
      const c = schema.indexOf(name);
      return c === undefined ? undefined : shown.map((row) => row[c]!);
    },
  };
  for (const c of order) {
    const { values, errors } = evaluateColumn(schema.formula(c)!, shown.length, columns);
    for (let i = 0; i < shown.length; i++) {
      shown[i]![c] = errors[i] === undefined ? formatValue(values[i]!) : ERR_CELL;
    }
  }
  return out;
}

/**
 * finishCells applies everything but formulas to one row. `shown` is a copy
 * of `raw` when a note or a formula writes into it, and `raw` itself
 * otherwise.
 *
 * `supplied` is the row's value for the schema's supplied column. It is
 * written into both `raw` and `shown`.
 */
function finishCells(
  schema: Schema,
  row: number,
  source: readonly string[],
  computed: boolean,
  supplied: string,
): Finished {
  const width = schema.headers.length;
  const written = schema.writtenIn(row);
  const fill = schema.supplied?.col;
  const raw: string[] = [];
  for (let c = 0; c < width; c++) {
    raw.push(c === fill ? supplied : stored(schema, c, written?.get(c), source));
  }

  let notes = false;
  if (written !== undefined) {
    for (const w of written.values()) {
      if (w.rendered !== undefined) {
        notes = true;
        break;
      }
    }
  }
  if (!computed && !notes) return { raw, shown: raw };

  const shown = raw.slice();
  if (notes) {
    for (const [c, w] of written!) if (w.rendered !== undefined) shown[c] = w.rendered;
  }
  return { raw, shown };
}
