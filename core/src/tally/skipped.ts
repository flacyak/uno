/**
 * @fileoverview What a fold left out.
 */

import { isCount, isRecord } from './saved.ts';

/** Cells or rows a fold left out, as blank or as not a number. */
export interface Skipped {
  blank: number;
  unparsed: number;
}

/** restoredSkipped is the counts `saved` holds, where it holds two. */
export function restoredSkipped(saved: unknown): Skipped | undefined {
  if (!isRecord(saved)) return undefined;
  const { blank, unparsed } = saved;
  return isCount(blank) && isCount(unparsed) ? { blank, unparsed } : undefined;
}
