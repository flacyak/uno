/**
 * @fileoverview Which smoke groups a run drives.
 *
 * The checks come in groups, one per file under smoke/, and most pick up the
 * window where the group before them left it. A group that opens a workspace
 * of its own starts afresh, and the groups after it lean on it, not on
 * anything earlier. A group that also reads what another run left names
 * that group in `needs`. UNO_SMOKE_ONLY names the groups to run; each runs
 * with the groups it leans on, back to the start of its run and through what
 * it needs, in the usual order.
 */

/** The variable that names the groups to run, comma separated. */
export const ONLY_VARIABLE = "UNO_SMOKE_ONLY";

/** A group of checks: its name, and whether it starts afresh. */
export interface Group {
  name: string;
  /** Whether the group opens its own workspace, leaning on nothing before it. */
  starts?: boolean;
  /** Groups in other runs whose leavings this one reads, each with its own run. */
  needs?: readonly string[];
}

/**
 * selected gives the groups a run drives, in order: every group when `only`
 * is unset or empty, otherwise each group it names and the groups that one
 * leans on, back to the nearest start and through what it needs. A name no
 * group has is an error.
 */
export function selected<G extends Group>(groups: readonly G[], only: string | undefined): G[] {
  const names = (only ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0) return [...groups];
  const wanted = new Set<number>();
  const want = (name: string): void => {
    const at = groups.findIndex((g) => g.name === name);
    if (at === -1) throw new Error(`${ONLY_VARIABLE} names no smoke group: ${name}`);
    for (let i = at; i >= 0 && !wanted.has(i); i--) {
      wanted.add(i);
      for (const needed of groups[i]?.needs ?? []) want(needed);
      if (groups[i]?.starts === true) break;
    }
  };
  for (const name of names) want(name);
  return groups.filter((_, i) => wanted.has(i));
}
