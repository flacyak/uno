// Where a driven run saves.
//
// Save As is a dialog, and a driven window ignores all input from the window
// system, a dialog included. So a driven run is told where to save in the
// environment. main uses this in place of the dialog when a run is driven;
// the plain app keeps asking.

import { basename, join } from "node:path";

/**
 * savePathFor is where a save goes, or undefined when UNO_SMOKE is empty or
 * absent, which leaves the dialog as the only way to get a path.
 *
 * Only the base name of the suggested name is used, so the save stays in the
 * scratch directory.
 *
 * @param env  usually process.env
 * @param suggestedName  what the renderer would have put in the dialog
 */
export function savePathFor(env: NodeJS.ProcessEnv, suggestedName: string): string | undefined {
  const dir = env["UNO_SMOKE"];
  if (dir === undefined || dir === "") return undefined;
  return join(dir, basename(suggestedName) || "workspace.uno");
}
