// Package program is uno's transform language: the string program a pattern
// proposal names, and the one a .uno log stores.
//
// Its text form is public API: a program in edits/log.jsonl is replayed by
// parsing it. It works on one string at a time.

export type { Program } from "./program.ts";
export { apply, describe, described, text } from "./program.ts";
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
export { describeStep, describedStep, posText, runStep, stepText } from "./steps.ts";
