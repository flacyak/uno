/**
 * @fileoverview The record.ts that pr-compare.ts imports as its sibling.
 * pr-compare.ts is kept byte for byte as the PR branch wrote it, where
 * record.ts sat beside it, so this file stands in that place and hands it the
 * real types.
 */

export type { Kind, Metric } from '../../../efficiency/record.ts';
