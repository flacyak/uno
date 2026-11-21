/**
 * @fileoverview A column's states, as a slope's form offers them: the values
 * its sample holds, the most common first, and the two it chooses.
 */

import { GROUPS_SENT } from "@engine";
import type { Band } from "@engine";
import { compareStrings } from "@go";
import { m } from "@paraglide/messages";
import { option } from "@renderer/shell/util";

/** The most of a column's values a slope's From and To offer: as many as a tally sends. */
export const STATES_AT_MOST = GROUPS_SENT;

/**
 * commonest gives the values of column `col` in the first `rows` rows `band`
 * holds, the most common first, ties in sort order, STATES_AT_MOST at most.
 */
export function commonest(band: Pick<Band, "raw" | "ready">, col: number, rows: number): string[] {
  const counts = new Map<string, number>();
  for (let row = 0; row < rows && band.ready(row); row++) {
    const cell = band.raw(row, col);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]));
  return ranked.slice(0, STATES_AT_MOST).map(([value]) => value);
}

/**
 * twoOf gives a slope's From and To of `states`, the most common first: the
 * two most common, the earlier in sort order From, as a year before the next.
 */
export function twoOf(states: readonly string[]): [string, string] {
  const [first = "", second = first] = states.slice(0, 2).sort(compareStrings);
  return [first, second];
}

/** stateOption offers a state: the file's value, or the app's word for a blank one. */
export function stateOption(value: string): HTMLOptionElement {
  const made = option(value === "" ? m.chart_blank_value() : value, value);
  made.className = value === "" ? "" : "from-file";
  return made;
}
