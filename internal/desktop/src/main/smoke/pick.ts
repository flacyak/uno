// What a driven run's Open dialog answers.
//
// A driven window ignores a dialog (see save.ts). The + at the foot of the
// sidebar asks for a file to open, so a driven run is told which file in the
// environment. main uses this in place of the dialog when a run is driven.

/** The variable a driven run names the file in. */
export const DRIVEN_OPEN = "UNO_DRIVEN_OPEN";

/**
 * openPathFor is the file a driven run's Open picks, or undefined when the
 * variable is empty or absent, the answer cancelling the dialog gives.
 *
 * @param env  usually process.env
 */
export function openPathFor(env: NodeJS.ProcessEnv): string | undefined {
  const path = env[DRIVEN_OPEN];
  return path === undefined || path === "" ? undefined : path;
}
