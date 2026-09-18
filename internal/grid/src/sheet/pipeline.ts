// Finishing a row: its source values, with the log applied.
//
// Every operation the log holds reads one row and nothing else, which is what
// lets this run over whichever rows someone is looking at, in any order. A
// formula is computed a column at a time across the block being read, and each
// of its cells still reads only its own row. Nothing here is kept. A row is finished when it is read, so an
// apply over 50 million rows costs one log line and the rows on screen.

import { formatFloat, roundSignificant } from "../go/index.ts";
import type { Columns } from "../formula/index.ts";
import { evaluateColumn } from "../formula/index.ts";
import { apply as applyProgram } from "../program/index.ts";
import type { Program } from "../program/index.ts";
import type { Schema, Written } from "./schema.ts";

/**
 * ERR_CELL is what a bound column shows where its expression could not read a
 * row: a divisor of zero, a cell holding "N/A".
 *
 * It is short because it has to fit a column sized for numbers, and it is
 * unmistakable because the alternative -- an empty cell -- reads as missing
 * data rather than as a failure. The reason is said in the editor, beside the
 * expression, where there is room for it.
 */
export const ERR_CELL = "#ERR";

/**
 * formatValue renders a computed number the way a spreadsheet does.
 *
 * The rounding is the point. (40.00 - 31.20) / 40.00 is 0.21999999999999997 in
 * binary floating point, and a column of those is arithmetic showing its
 * working. Ten significant digits is far more precision than a cell displays
 * and far less than float64 noise, so it removes the artefact without removing
 * an answer. The second pass turns the result back into plain notation, since a
 * spreadsheet column showing 1.234567890e+12 has helped nobody.
 */
export function formatValue(v: number): string {
  return formatFloat(roundSignificant(v, 10));
}

/** A row with the log applied: what each cell stores, and what it shows. */
export interface Finished {
  /** What the log records, undo restores and the recogniser reads. */
  raw: readonly string[];
  /** What the grid draws: raw, except where notation or a formula fills a cell. */
  shown: readonly string[];
}

/**
 * valueAt is what one cell stores: the last value written into it, or else its
 * source value, rewritten by every program recorded after that.
 *
 * Order is the rule. A value typed before an apply is rewritten by it and one
 * typed after is not, because the programs that count are the ones with a later
 * sequence number than the write. The exception is a write the program is
 * settled over -- see `settled`.
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
    // A cell the source row does not reach and nobody wrote into is not there,
    // and a program has nothing in it to rewrite. A short row stays short.
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
 * settled says whether a program has nothing left to do in a written cell: run
 * over what the cell held before it was typed into, it gives what was typed.
 *
 * Those are the fixes the recogniser learned the program from, and they are
 * typed before the apply that follows. Running the program over them again
 * fixes them twice -- remove commas does not show it, but 12 fixed to 12.00
 * would read 12.00.00. So an apply leaves such a cell alone, and the recogniser
 * does not count it.
 */
export function settled(prog: Program, w: Pick<Written, "was" | "now">): boolean {
  return w.was !== undefined && applyProgram(prog, w.was) === w.now;
}

/**
 * finish applies the log to one source row. It is `finishRows` over a block of
 * one, for a caller holding a single row.
 */
export function finish(schema: Schema, row: number, source: readonly string[]): Finished {
  return finishRows(schema, row, [source])[0]!;
}

/**
 * finishRows applies the log to a block of source rows, the first of which is
 * row `first`.
 *
 * Everything but formulas is finished a row at a time. Formulas are then
 * computed a column at a time over the block: a bound column is one expression
 * over a whole column, so it is walked once for the block rather than once per
 * row.
 *
 * A row nothing touched comes back as the source itself, with no copy, so a
 * file with an empty log reads as fast as it did before there was a log.
 */
export function finishRows(
  schema: Schema,
  first: number,
  sources: readonly (readonly string[])[],
): Finished[] {
  if (schema.empty) return sources.map((source) => ({ raw: source, shown: source }));

  const order = schema.computedColumns();
  const out = sources.map((source, i) => finishCells(schema, first + i, source, order.length > 0));
  if (order.length === 0 || out.length === 0) return out;

  // A formula reads what a cell shows, not what it stores: a column it names may
  // be bound too, and what that column is worth is what it computed. The order
  // puts every bound column after the ones it reads, so the answer is written
  // into the block before it is gathered from it.
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
 * finishCells applies everything in the log but formulas to one row. shown is
 * a copy of raw wherever a formula is about to write into it.
 */
function finishCells(
  schema: Schema,
  row: number,
  source: readonly string[],
  computed: boolean,
): Finished {
  const width = schema.headers.length;
  const written = schema.writtenIn(row);
  const raw: string[] = [];
  for (let c = 0; c < width; c++) raw.push(stored(schema, c, written?.get(c), source));

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
