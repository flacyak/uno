// Package formula is the arithmetic a column formula binds: the expression
// tree, its text form, the evaluator and the dependency graph.
//
// The text form is stored in the .uno beside the library reference, so a
// file computes from the text alone. `sheet` depends on this package, and
// cells reach an expression through `Columns` or `Row`.

export { Formula, text } from "./ast.ts";
export type { Binary, ColRef, Group, Node, NumLit, Unary } from "./ast.ts";
export { parse } from "./parse.ts";
export {
  DivideByZeroError,
  EmptyFormulaError,
  NotNumberError,
  UnknownColumnError,
  evaluate,
  evaluateColumn,
} from "./eval.ts";
export type { Column, Columns, Row } from "./eval.ts";
export { Graph } from "./graph.ts";
