/**
 * @fileoverview What a fold holds, as a save writes it and reads it back.
 */

import type { Mark } from '@num';

/**
 * What a fold holds of the cells it reads, bumped when a fold, how a cell
 * reads as a number, or how a formula computes one changes it. A fold a save
 * wrote under another version is folded again. tests/tally/saved.test.ts
 * pins it.
 */
export const TALLY_VERSION = 1;

/** isRecord says whether `v` is an object of named fields. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** isCount says whether `v` is a whole count of rows or cells. */
export function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** isMark says whether `v` is a decimal mark a fold reads cells with. */
export function isMark(v: unknown): v is Mark {
  return v === 'point' || v === 'comma';
}
