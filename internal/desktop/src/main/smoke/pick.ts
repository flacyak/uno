// What a driven run opens.
//
// Open is a dialog, as Save As is, and a driven window can answer neither --
// see save.ts. The + at the foot of the sidebar asks for a file to open, so a
// run that presses it is told which file instead of being asked: an
// environment in, a path out, no fs and no Electron. main swaps it in for the
// dialog inside the branch that already knows what a test is.

/** The variable a driven run names the file in. */
export const DRIVEN_OPEN = "UNO_DRIVEN_OPEN";

/**
 * openPathFor is the file a driven run's Open picks, or undefined when nobody
 * said, which is what cancelling the dialog answers.
 *
 * @param env  usually process.env
 */
export function openPathFor(env: NodeJS.ProcessEnv): string | undefined {
  const path = env[DRIVEN_OPEN];
  return path === undefined || path === "" ? undefined : path;
}
