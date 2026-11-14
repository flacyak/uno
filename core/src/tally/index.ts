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
export type { Group, Groups, Measure, SavedGroups } from './groups.ts';
export { SCATTER_POINTS_AT_MOST, SampleFold } from './sample.ts';
export type { Marks, SavedSample } from './sample.ts';
export type { Point, Sample } from './sample.ts';
export { TALLY_VERSION, isCount, isRecord } from './saved.ts';
export type { Skipped } from './skipped.ts';
