import type { Step } from "./steps.ts";
import { english } from "../said/index.ts";
import type { Said } from "../said/index.ts";
import { describedStep, runStep, stepText } from "./steps.ts";

/**
 * Program is a pipeline of steps applied left to right. The empty Program is
 * valid and returns the value as it is.
 */
export type Program = Step[];

/**
 * apply runs the pipeline over one value. If any step fails to apply, the
 * original value is returned unchanged.
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

/** text is the text form, which a .uno log carries. */
export function text(p: Program): string {
  return p.map(stepText).join(" | ");
}

/**
 * describe renders the program in plain English. A slice, a concat or a
 * constant is shown in program notation.
 */
export function describe(p: Program): string {
  return english(described(p));
}

/** described returns what `describe` says, as data. */
export function described(p: Program): Said {
  return { t: "program", steps: p.map(describedStep) };
}
