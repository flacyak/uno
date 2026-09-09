// Package program is uno's transform language: the small string program a
// pattern proposal names, and the one a .uno log stores.
//
// It is its own module rather than part of `sheet` because its text form is
// public API. A program written into edits/log.jsonl has to be readable years
// from now by a build whose synthesiser has been rewritten, or removed
// entirely, so what the log carries is the program itself and replay is
// interpretation rather than a second guess at it. Nothing here knows what a
// sheet is.

export type { Program } from "./program.ts";
export { apply, describe, text } from "./program.ts";
export { parse } from "./parse.ts";
export { MAX_PARTS, MAX_STEPS, literalOf, nameChars, newReplace, quoteRegex } from "./steps.ts";
export type {
  CaseStep,
  ConcatStep,
  ConstStep,
  IdxPos,
  LenPos,
  MatchPos,
  Pos,
  ReplaceStep,
  SliceStep,
  Step,
  TrimStep,
} from "./steps.ts";
export { describeStep, posText, runStep, stepText } from "./steps.ts";
