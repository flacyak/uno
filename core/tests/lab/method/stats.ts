/**
 * @fileoverview Order statistics for repeated measurements: min, median,
 * quantiles and two measures of spread, each relative to the median so that
 * metrics of different sizes can be read side by side.
 */

/** Percent in a whole. */
export const PERCENT = 100;
/** The quantile a median is. */
const HALF = 0.5;

/** Summary is what a list of measurements of one metric comes to. */
export interface Summary {
  n: number;
  min: number;
  median: number;
  max: number;
  /** (max - min) / median, in percent. */
  rangePct: number;
  /** The median absolute deviation over the median, in percent. */
  madPct: number;
}

function sorted(values: readonly number[]): number[] {
  if (values.length === 0) throw new Error('no values to summarize');
  return values.toSorted((a, b) => a - b);
}

/**
 * quantile returns the q-th quantile, 0 <= q <= 1, interpolating linearly
 * between the two nearest ranks.
 */
export function quantile(values: readonly number[], q: number): number {
  if (q < 0 || q > 1) throw new Error(`quantile ${q} is outside 0 to 1`);
  const s = sorted(values);
  const at = q * (s.length - 1);
  const below = Math.floor(at);
  const above = Math.ceil(at);
  return s[below]! + (s[above]! - s[below]!) * (at - below);
}

export function median(values: readonly number[]): number {
  return quantile(values, HALF);
}

/** relative returns part over whole in percent, or 0 when whole is 0. */
function relative(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / Math.abs(whole)) * PERCENT;
}

export function summarize(values: readonly number[]): Summary {
  const s = sorted(values);
  const mid = median(s);
  const deviations = s.map((v) => Math.abs(v - mid));
  return {
    n: s.length,
    min: s[0]!,
    median: mid,
    max: s[s.length - 1]!,
    rangePct: relative(s[s.length - 1]! - s[0]!, mid),
    madPct: relative(median(deviations), mid),
  };
}

/**
 * changePct is how far `head` is from `base`, in percent of base. Positive
 * is larger, which for every metric here is worse.
 */
export function changePct(base: number, head: number): number {
  return relative(head - base, base);
}

/**
 * pairwiseAbsChangePct is |changePct| over every ordered pair of distinct
 * measurements. For measurements of one unchanged commit it is a sample of
 * what a single-run comparison reads when nothing changed.
 */
export function pairwiseAbsChangePct(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      if (i !== j) out.push(Math.abs(changePct(values[i]!, values[j]!)));
    }
  }
  return out;
}
