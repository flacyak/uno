/**
 * @fileoverview Where a bar a person moves stands, and what its chart's
 * record keeps of it: the values moved, in the order they stand before the
 * rest, which stand largest first.
 */

import type { Plot } from "@document";
import { GROUPS_SENT } from "@engine";
import type { Press } from "@renderer/keys";

/** A plot whose rows a person moves, which keeps their `order`: bars, stacked or not, and dots. */
export type Arranged = Extract<Plot, { t: "bars" | "stack" | "dots" }>;

/** arranged says whether a person moves `plot`'s rows. */
export function arranged(plot: Plot): plot is Arranged {
  return plot.t === "bars" || plot.t === "stack" || plot.t === "dots";
}

/**
 * Where Alt with each key moves the bar under the cursor, from `at` among
 * `count` bars: up and down one, and to the top and the bottom.
 */
const MOVES: ReadonlyMap<string, (at: number, count: number) => number> = new Map([
  ["ArrowUp", (at: number) => at - 1],
  ["ArrowDown", (at: number) => at + 1],
  ["Home", () => 0],
  ["End", (_at: number, count: number) => count - 1],
]);

/** The keys that move a bar, as a plot names them for a screen reader. */
export const MOVE_KEYS = [...MOVES.keys()].map((key) => `Alt+${key}`);

/** movedTo gives where `press` moves the bar at `at` among `count`, or none for another key. */
export function movedTo(press: Press, at: number, count: number): number | undefined {
  if (!press.alt || press.ctrl || press.meta || press.shift) return undefined;
  const to = MOVES.get(press.key)?.(at, count);
  return to === undefined ? undefined : Math.max(0, Math.min(to, count - 1));
}

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
