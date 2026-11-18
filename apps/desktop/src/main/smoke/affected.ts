/**
 * @fileoverview Which smoke groups a set of changed files touches.
 *
 * smoke-groups.json, in the package folder, maps paths from the repository
 * root to the groups they can break: a list of group names, "all", or "none".
 * The first entry whose glob matches a path decides for it, so the specific
 * entries come first in the file. A path no entry matches runs everything,
 * and the test over the file keeps that from happening to a tracked file: a
 * gap in the map costs time, never coverage.
 */

import { matchesGlob } from "node:path";

/** What one entry maps to. */
export type Covers = readonly string[] | "all" | "none";

/**
 * The map, glob to what it covers, in the order the entries decide. A JSON
 * import types its words as strings, so a word is checked where it is read.
 */
export type SmokeMap = Readonly<Record<string, readonly string[] | string>>;

/** What a set of changed paths asks of the smoke. */
export interface Affected {
  /** The groups to run, or every group. */
  groups: readonly string[] | "all";
  /** The paths no entry matched, which are why `groups` is every group. */
  unmapped: readonly string[];
}

/** covering is the first entry that matches `path`, or undefined when none does. */
export function covering(map: SmokeMap, path: string): Covers | undefined {
  for (const [glob, covers] of Object.entries(map)) {
    if (!matchesGlob(path, glob)) continue;
    if (covers === "all" || covers === "none" || typeof covers !== "string") return covers;
    throw new Error(
      `smoke-groups.json maps ${glob} to ${JSON.stringify(covers)}, not groups, "all" or "none"`,
    );
  }
  return undefined;
}

/**
 * affected gives the groups the changed `paths` touch, in no particular
 * order: every group when any path maps to "all" or to nothing, otherwise
 * the union of what each path maps to, which is empty when none touches
 * the app.
 */
export function affected(map: SmokeMap, paths: readonly string[]): Affected {
  const groups = new Set<string>();
  const unmapped: string[] = [];
  let all = false;
  for (const path of paths) {
    const covers = covering(map, path);
    if (covers === undefined) unmapped.push(path);
    else if (covers === "all") all = true;
    else if (covers !== "none") for (const g of covers) groups.add(g);
  }
  if (all || unmapped.length > 0) return { groups: "all", unmapped };
  return { groups: [...groups], unmapped };
}
