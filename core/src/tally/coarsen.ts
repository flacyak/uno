/**
 * @fileoverview Coarsening, shared by every fold that holds counts by a
 * numeric key and merges them into coarser keys past a bound: periods into
 * days, months and years, and lat/lon cells into their parents.
 */

import type { Count } from './groups.ts';

/**
 * coarsen merges every count in `counts` into the key `coarser` gives its
 * own, in place: rows, numbers and blanks added, and sums merged exactly, so
 * the merged fold is the fold of the same rows at the coarser keys.
 */
export function coarsen(
  counts: Map<number, Count>,
  coarser: (key: number) => number,
): void {
  const finer = [...counts];
  counts.clear();
  for (const [key, count] of finer) {
    const into = counts.get(coarser(key));
    if (into === undefined) {
      counts.set(coarser(key), count);
      continue;
    }
    into.rows += count.rows;
    into.numbers += count.numbers;
    into.blank += count.blank;
    into.sum.merge(count.sum);
  }
}
