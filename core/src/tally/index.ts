/**
 * @fileoverview Package tally adds up a column's numbers for its charts.
 */

export { ExactSum } from './exact.ts';
export type { SavedSum } from './exact.ts';
export {
  DISTINCT_AT_MOST,
  GROUPS_SENT,
  GroupsFold,
  LABEL_AT_MOST,
} from './groups.ts';
export type {
  Group,
  Groups,
  MeanGroup,
  Measure,
  SavedGroups,
} from './groups.ts';
export { SCATTER_POINTS_AT_MOST, SampleFold } from './sample.ts';
export type { Marks, SavedSample } from './sample.ts';
export type { Point, Sample } from './sample.ts';
export { FIGURES_AT_MOST, SPREAD_AT_MOST, SpreadFold } from './spread.ts';
export type { Bucket, Figures, SavedSpread, Spreading } from './spread.ts';
export type { Box, Past, Span, Spread, Within } from './spread.ts';
export {
  BOX_VALUES_AT_MOST,
  SPREAD_VALUE_AT_MOST,
  SpreadsFold,
} from './spreads.ts';
export type { SavedSpreads, Spreads, ValueSpread } from './spreads.ts';
export { edgeOf } from './levels.ts';
export type { Level } from './levels.ts';
export { PAIRS_AT_MOST, SERIES_AT_MOST, SplitFold } from './split.ts';
export type {
  Ended,
  Measured,
  SavedCell,
  SavedSplit,
  SavedTally,
  Slope,
  SlopeValue,
  Split,
  SplitValue,
} from './split.ts';
export { TALLY_VERSION, isCount, isRecord } from './saved.ts';
export {
  HELD,
  HELD_AT_MOST,
  LEVEL_BATCH,
  PER,
  TimeFold,
  sundayOf,
} from './time.ts';
export type {
  Held,
  Per,
  Period,
  Periods,
  SavedTime,
  TimeLevel,
  Times,
  Undated,
} from './time.ts';
export type { Skipped } from './skipped.ts';
