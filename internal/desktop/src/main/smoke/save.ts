// Where a driven run saves.
//
// Save As is a dialog, and a dialog is the one thing a driven window cannot
// answer: the window ignores the window system so nobody at the desktop can
// disturb the run, which means nobody -- including the run -- can press Save.
// The modal then sits there until the deadline kills the app, and a run that
// can never save can never check that a workspace holding an S3 object saves as
// an s3:// pointer.
//
// So the run is told where to save instead of being asked, and this is the whole
// of the telling: an environment in, a path out, no fs and no Electron. main
// swaps it in for the dialog inside the branch that already knows what a test
// is, and the app a person installed keeps asking the way it always has.

import { basename, join } from "node:path";

/**
 * savePathFor is where a save should go, or undefined when nobody said.
 *
 * `undefined` is the honest answer outside a driven run and the one that leaves
 * the dialog as the only way to get a path, which is what the plain app wants.
 *
 * The suggested name is reduced to a name. The renderer offers it -- named after
 * the first source -- and a run that wrote somewhere other than the scratch
 * directory it was given would be a mess nobody finds until it has been made.
 *
 * @param env  usually process.env
 * @param suggestedName  what the renderer would have put in the dialog
 */
export function savePathFor(env: NodeJS.ProcessEnv, suggestedName: string): string | undefined {
  const dir = env["UNO_SMOKE"];
  if (dir === undefined || dir === "") return undefined;
  return join(dir, basename(suggestedName) || "workspace.uno");
}
