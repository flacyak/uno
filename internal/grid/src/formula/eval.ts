import { quote } from "../go/index.ts";
import { parse as parseNumber } from "../num/index.ts";
import type { Formula, Node } from "./ast.ts";
import { text } from "./ast.ts";

/**
 * Row is one row of whatever the caller holds. It is an interface, and a
 * deliberately small one, because `formula` must never learn what a sheet is:
 * `sheet` imports `formula` to bind a column, so an import the other way would
 * be a cycle.
 *
 * value returns the cell as it is stored -- a string -- and undefined when
 * there is no such column. Coercion happens here rather than at the caller, so
 * every binding reads a number the same way.
 */
export interface Row {
  value(col: string): string | undefined;
}

/**
 * The three ways one cell can fail.
 *
 * They are classes because the caller decides what a failure looks like: the
 * editor's preview says it in words beside the expression, and a bound column
 * shows it in the cell it happened in. `instanceof` is what Go spells
 * `errors.Is`.
 */
export class UnknownColumnError extends Error {}
export class NotNumberError extends Error {}
export class DivideByZeroError extends Error {}
export class EmptyFormulaError extends Error {}

/**
 * Column is what a formula computed over a run of rows: one number per row, and
 * the reason for each row it could not compute.
 *
 * values is a Float64Array because a column of numbers is what this is, and one
 * contiguous allocation per term is the cost of a block rather than of a row.
 * errors is sparse: a row with nothing in it computed, and a row with an Error
 * shows the failure and not what values holds there.
 */
export interface Column {
  readonly values: Float64Array;
  readonly errors: readonly (Error | undefined)[];
}

/**
 * Columns is the source of the cells a column formula reads. column returns
 * every cell of the named column across the rows being computed, as stored,
 * and undefined when there is no such column. Like Row, it is how `formula`
 * reads a sheet without knowing what one is.
 */
export interface Columns {
  column(name: string): readonly string[] | undefined;
}

/**
 * evaluateColumn computes the expression over n rows at once.
 *
 * A formula is bound to a whole column, so it is computed a whole column at a
 * time: the tree is walked once per block rather than once per row, a name is
 * resolved once per reference rather than once per cell, and each operator is
 * a tight loop over two arrays.
 *
 * A row fails with the error a row-by-row walk would have thrown first. Terms
 * are computed left to right and depth first, the same order, and a row keeps
 * the first error it meets: a later term neither reads it nor replaces what it
 * says.
 */
export function evaluateColumn(f: Formula, n: number, src: Columns): Column {
  const errors: (Error | undefined)[] = Array.from({ length: n });
  if (f.root === undefined) {
    const err = new EmptyFormulaError("the formula is empty");
    for (let i = 0; i < n; i++) errors[i] = err;
    return { values: new Float64Array(n), errors };
  }
  return { values: evalNode(f.root, n, src, errors), errors };
}

/**
 * evaluate computes the expression for one row, which is what the editor's
 * preview asks.
 *
 * It is a column one row long rather than a second evaluator, so the preview
 * cannot disagree with the column it previews.
 *
 * It throws the row's failure, and the failure names the column, because
 * "not a number" over 4,812 rows is not a thing anyone can act on. That is the
 * opposite of what `program.apply` does with a value it does not fit: a program
 * is induced from a handful of rows and meets others as a matter of course, and
 * a formula is typed by a person against a column they chose.
 */
export function evaluate(f: Formula, row: Row): number {
  const { values, errors } = evaluateColumn(f, 1, {
    column(name) {
      const v = row.value(name);
      return v === undefined ? undefined : [v];
    },
  });
  if (errors[0] !== undefined) throw errors[0];
  return values[0]!;
}

function evalNode(
  n: Node,
  count: number,
  src: Columns,
  errors: (Error | undefined)[],
): Float64Array {
  switch (n.kind) {
    case "num":
      return new Float64Array(count).fill(n.value);

    case "col": {
      const out = new Float64Array(count);
      const cells = src.column(n.name);
      if (cells === undefined) {
        const err = new UnknownColumnError(`${n.name}: no such column`);
        for (let i = 0; i < count; i++) errors[i] ??= err;
        return out;
      }
      for (let i = 0; i < count; i++) {
        if (errors[i] !== undefined) continue;
        const raw = cells[i] ?? "";
        const v = parseNumber(raw);
        if (v === undefined) {
          errors[i] = new NotNumberError(`${n.name} = ${quote(raw)}: not a number`);
        } else out[i] = v;
      }
      return out;
    }

    case "group":
      return evalNode(n.inner, count, src, errors);

    case "unary": {
      const out = evalNode(n.operand, count, src, errors);
      for (let i = 0; i < count; i++) out[i] = -out[i]!;
      return out;
    }

    case "binary": {
      // Both operands are fresh arrays nothing else holds, so the result is
      // written over the left one rather than into a third.
      const left = evalNode(n.left, count, src, errors);
      const right = evalNode(n.right, count, src, errors);
      switch (n.op) {
        case "+":
          for (let i = 0; i < count; i++) left[i] = left[i]! + right[i]!;
          return left;
        case "-":
          for (let i = 0; i < count; i++) left[i] = left[i]! - right[i]!;
          return left;
        case "*":
          for (let i = 0; i < count; i++) left[i] = left[i]! * right[i]!;
          return left;
        case "/":
          // Refused rather than left to produce Infinity or NaN. A column of
          // infinities is a wrong answer that displays as one, and the divisor
          // is named because on a bound column the person needs to know which
          // cell was empty. A row that already failed keeps its first reason.
          for (let i = 0; i < count; i++) {
            if (right[i] === 0 && errors[i] === undefined) {
              errors[i] = new DivideByZeroError(`${text(n.right)}: divide by zero`);
            }
            left[i] = left[i]! / right[i]!;
          }
          return left;
      }
    }
  }
}
