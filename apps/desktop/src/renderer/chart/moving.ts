/**
 * @fileoverview Where a bar a person moves stands, and what its chart's
 * record keeps of it: the values moved, in the order they stand before the
 * rest, which stand largest first.
 */

import { GROUPS_SENT } from "@engine";

/**
 * movedOrder gives a chart's `order` once the bar at `from` among `drawn`, the
 * values its bars stand for top to bottom, moves to `to`. The values `before`
 * moved stand first, so every bar from the top down to the moved one, and
 * down to the last moved before, keeps its place; the rest stay largest
 * first. A value moved before that draws no bar stays in the order, after.
 */
export function movedOrder(
  drawn: readonly string[],
  before: readonly string[],
  from: number,
  to: number,
): string[] {
  const now = [...drawn];
  const [value] = now.splice(from, 1);
  if (value === undefined) return [...before];
  const at = Math.max(0, Math.min(to, now.length));
  now.splice(at, 0, value);
  const last = Math.max(at, ...now.map((v, i) => (before.includes(v) ? i : -1)));
  const absent = before.filter((v) => !drawn.includes(v));
  return [...now.slice(0, last + 1), ...absent].slice(0, GROUPS_SENT);
}
