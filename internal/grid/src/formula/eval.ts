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
 * evaluate computes the expression for one row.
 *
 * It reports a failure rather than swallowing it, which is the opposite of what
 * `program.apply` does with a value it does not fit. The difference is where
 * the two come from: a program is induced from a handful of rows and then run
 * over thousands, so meeting a row it was not induced from is ordinary. A
 * formula is typed by a person against a column they chose, so a row it cannot
 * read is something they got wrong and would want told about -- with the column
 * named, because "not a number" over 4,812 rows is not a thing anyone can act on.
 *
 * It throws rather than returning a result object. Recalculation runs this once
 * per row over the whole column, and a wrapper allocated per row would put a
 * cost on the path that succeeds in order to describe the path that does not.
 */
export function evaluate(f: Formula, row: Row): number {
  if (f.root === undefined) throw new EmptyFormulaError("the formula is empty");
  return evalNode(f.root, row);
}

function evalNode(n: Node, row: Row): number {
  switch (n.kind) {
    case "num":
      return n.value;

    case "col": {
      const raw = row.value(n.name);
      if (raw === undefined) {
        throw new UnknownColumnError(`${n.name}: no such column`);
      }
      const v = parseNumber(raw);
      if (v === undefined) {
        throw new NotNumberError(`${n.name} = ${quote(raw)}: not a number`);
      }
      return v;
    }

    case "group":
      return evalNode(n.inner, row);

    case "unary":
      return -evalNode(n.operand, row);

    case "binary": {
      const left = evalNode(n.left, row);
      const right = evalNode(n.right, row);
      switch (n.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          // Refused rather than left to produce Infinity or NaN. A column of
          // infinities is a wrong answer that displays as one, and the divisor
          // is named because on a bound column the person needs to know which
          // cell was empty.
          if (right === 0) {
            throw new DivideByZeroError(`${text(n.right)}: divide by zero`);
          }
          return left / right;
      }
    }
  }
}
