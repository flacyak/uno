/**
 * @fileoverview The file paths on a command line.
 *
 * The same line reaches main twice over: as this process's argv at launch,
 * and as the argv of a second uno that was started while this one runs.
 * Chromium passes the second's on with its switches moved to the front, so
 * nothing here depends on where an argument is.
 */

import { resolve } from "node:path";

/**
 * filesNamed returns the file paths in `argv`, made absolute against `cwd`.
 *
 * The first argument is the executable. Arguments starting with a dash are
 * Electron's switches. In development one names the app Electron was told
 * to run, `appPath` once resolved, and the packaged app never has it on the
 * line. Paths are resolved against `cwd`, the directory the line was typed
 * in, because a workspace stores absolute paths to its sources.
 */
export function filesNamed(argv: readonly string[], cwd: string, appPath: string): string[] {
  const app = resolve(appPath);
  return argv
    .slice(1)
    .filter((a) => !a.startsWith("-"))
    .map((a) => resolve(cwd, a))
    .filter((a) => a !== app);
}
