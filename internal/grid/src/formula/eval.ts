import { quote } from "../go/index.ts";
import { parse as parseNumber } from "../num/index.ts";
import type { Formula, Node } from "./ast.ts";
import { text } from "./ast.ts";

/**
 * Row is one row of cells, read by column name. `value` returns the cell as
 * stored, or undefined for an unknown column.
 */
export interface Row {
  value(col: string): string | undefined;
}

/**
 * The ways a cell can fail. Callers test them with `instanceof`.
 */
export class UnknownColumnError extends Error {}
export class NotNumberError extends Error {}
export class DivideByZeroError extends Error {}
export class EmptyFormulaError extends Error {}

/**
 * Column is a formula's result over a run of rows: one number per row, and
 * for each row that failed, its error. `errors` is sparse. A row's value
 * counts only where its error is undefined.
 */
export interface Column {
  readonly values: Float64Array;
  readonly errors: readonly (Error | undefined)[];
}

/**
 * Columns is the source a column formula reads. `column` returns every cell
 * of the named column over the rows being computed, as stored, or undefined
 * for an unknown column.
 */
export interface Columns {
  column(name: string): readonly string[] | undefined;
}

/**
 * evaluateColumn computes the expression over `n` rows at once. The tree is
 * walked once per block, and each operator is one loop over two arrays.
 *
 * A row keeps the first error it meets, in left-to-right, depth-first
 * order, through every later term.
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
 * evaluate computes the expression for one row. It is evaluateColumn over a
 * block of one, and it throws the row's error if there is one.
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
      // Both operands are fresh arrays, so the result is written over the
      // left one.
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
        case "/": {
          // A zero divisor is an error. The error names the divisor
          // expression, and one Error object is shared by every failing row
          // in the block. A row that already failed keeps its first error.
          let err: DivideByZeroError | undefined;
          for (let i = 0; i < count; i++) {
            if (right[i] === 0 && errors[i] === undefined) {
              err ??= new DivideByZeroError(`${text(n.right)}: divide by zero`);
              errors[i] = err;
            }
            left[i] = left[i]! / right[i]!;
          }
          return left;
        }
      }
    }
  }
}
