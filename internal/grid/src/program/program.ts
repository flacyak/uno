import type { Step } from "./steps.ts";
import { describeStep, runStep, stepText } from "./steps.ts";

/**
 * Program is a pipeline applied left to right. The empty Program is valid and
 * changes nothing, which is what lets a caller treat "no transform" as a
 * program rather than as a special case.
 */
export type Program = Step[];

/**
 * apply runs the pipeline over one value.
 *
 * A program applies wholly or not at all: a step that does not fit abandons the
 * whole pipeline and the original value is returned. Half-transforming a cell --
 * trimming it and then failing to slice it -- would leave data in a state no
 * program describes, and would make the count of affected cells a guess.
 */
export function apply(p: Program, v: string): string {
  let out = v;
  for (const s of p) {
    const got = runStep(s, out);
    if (got === undefined) return v;
    out = got;
  }
  return out;
}

/** The text form, which is what a .uno log carries. */
export function text(p: Program): string {
  return p.map(stepText).join(" | ");
}

/**
 * describe names the program in the plain language a banner asks the question
 * in.
 *
 * It falls back to the program text for anything it cannot name, which is the
 * honest answer: a person asked to approve a transformation is better shown a
 * notation they can learn than a description that glosses over what it does.
 */
export function describe(p: Program): string {
  if (p.length === 0) return "change nothing";
  return p.map(describeStep).join(", then ");
}
