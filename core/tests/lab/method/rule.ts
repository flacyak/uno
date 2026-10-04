/**
 * @fileoverview The verdict PR #65's report gives one metric, reproduced
 * from internal/grid/tests/efficiency/compare.ts on origin/t3/performance-workflow
 * (lines 41-76) so the lab can count what the workflow would print.
 *
 * Only a metric whose unit is exactly "ms" gets the noise rule. Any other
 * unit is treated as exact, so a ratio of two timings ("x") or a heap figure
 * ("bytes") is called better or worse on any difference at all.
 */

/** The unit the rule treats as wall clock. */
export const CLOCK_UNIT = 'ms';
/** The fraction under which a wall-clock change reads as noise. */
export const NOISE_FRACTION = 0.05;

/** Call is the word the report's Change column starts with. */
export type Call = 'new' | 'gone' | 'same' | 'better' | 'worse' | 'noise';

/** verdict is compare.ts's verdict without the printed percentage. */
export function verdict(
  unit: string,
  base: number | undefined,
  head: number | undefined,
): Call {
  if (base === undefined) return 'new';
  if (head === undefined) return 'gone';
  if (head === base) return 'same';
  const fraction = base === 0 ? undefined : (head - base) / base;
  if (unit !== CLOCK_UNIT) return head < base ? 'better' : 'worse';
  if (fraction !== undefined && Math.abs(fraction) < NOISE_FRACTION) {
    return 'noise';
  }
  return head < base ? 'better' : 'worse';
}

/** claimed says whether a call tells the reader something changed. */
export function claimed(call: Call): boolean {
  return call === 'better' || call === 'worse';
}
