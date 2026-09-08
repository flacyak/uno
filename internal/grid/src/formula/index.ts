// Package formula is uno's arithmetic: the expression a column formula binds,
// and the text a .unof carries.
//
// Its text form is public API. A .uno stores the expression beside the library
// reference so the file stays self-contained for someone who does not have the
// sender's library, and an expression this build cannot read has to fail before
// a single cell moves. Parsing is therefore interpretation of a stored text
// rather than a second guess at it.
//
// Nothing here knows what a sheet is. Cells reach an expression through
// `Columns`, a column at a time, or through `Row` for a single preview, which
// is what lets `sheet` import `formula` without `formula` importing
// `sheet` back.
//
// It is not `program`. A program is a string-rewriting pipeline with no numbers,
// no operators and no infix; its slash is a regex delimiter. Nothing in it
// composes into an expression tree, so nothing in it is reused here.

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
