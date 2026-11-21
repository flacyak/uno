/**
 * @fileoverview Package tally adds up a column's numbers for its charts.
 */

export { coarsen } from './coarsen.ts';
export { ExactSum } from './exact.ts';
export { CELLS_AT_MOST, GridFold } from './grid.ts';
export type { Cells, Coords, Unplaced } from './grid.ts';
export { LEVEL_FINEST, cellAt, parentOf } from './quad.ts';
export type { SavedSum } from './exact.ts';
export {
  Count,
  DISTINCT_AT_MOST,
  GROUPS_SENT,
  GroupsFold,
  LABEL_AT_MOST,
  counted,
} from './groups.ts';
export type {
  Group,
  Groups,
  MeanGroup,
  Measure,
  SavedGroups,
} from './groups.ts';
export {
  SCATTER_POINTS_AT_MOST,
  SampleFold,
  pointsOf,
  restoredPoints,
  savedPoints,
} from './sample.ts';
export type { Marks, SavedSample, SavedSampled } from './sample.ts';
export type { Point, Sample, Sampled } from './sample.ts';
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
  sizer,
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
export { DAY_HOURS, WEEK_DAYS, WEEK_HOURS, WeekFold } from './week.ts';
export type { SavedWeek, Week } from './week.ts';
export { SPLIT_VALUES_SENT, TimeSplitFold } from './timesplit.ts';
export type {
  Ranked,
  SavedTimeSplit,
  SentValue,
  SplitLevel,
  TimeSplitSnapshot,
  TimeSplits,
  ValuePeriods,
} from './timesplit.ts';
export { SWARM_ROWS_AT_MOST, SwarmFold } from './swarm.ts';
export type { SavedKept, SavedSwarm, Strip, Swarm } from './swarm.ts';
export type { Skipped } from './skipped.ts';
