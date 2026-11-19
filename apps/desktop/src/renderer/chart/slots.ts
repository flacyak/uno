/**
 * @fileoverview Which colour each series of a stacked chart wears. A series
 * keeps its slot, --chart-1 to --chart-6, for the session, so a refresh that
 * reorders the series never repaints one a reader follows. The slots are not
 * saved, so a reopened workspace starts again from the series' ranks.
 */

import type { StackTally } from "@engine";

/**
 * slotted gives the series of `now` in the slots they wear, after they wore
 * `was`. With none before, they take the slots in rank order. A series that
 * stays keeps its slot, one that enters takes a slot one that left freed,
 * and where fewer are shown than before, those above a gap move down one
 * each, so slots 1 to k are always the ones worn.
 */
export function slotted(was: readonly string[], now: readonly string[]): string[] {
  const stays = new Set(now);
  const slots = was.map((series) => (stays.has(series) ? series : undefined));
  const worn = new Set(was);
  const entering = now.filter((series) => !worn.has(series));
  for (const [i, series] of slots.entries()) {
    if (series === undefined && entering.length > 0) slots[i] = entering.shift();
  }
  return [...slots.filter((series) => series !== undefined), ...entering];
}

/**
 * inSlots gives `tally` with its series, and each value's cells, in the
 * order of `slots`, which holds each of its series once.
 */
export function inSlots(tally: StackTally, slots: readonly string[]): StackTally {
  const from = slots.map((series) => tally.series.indexOf(series));
  return {
    ...tally,
    series: [...slots],
    values: tally.values.map((v) => ({ ...v, cells: from.map((i) => v.cells[i]!) })),
  };
}
