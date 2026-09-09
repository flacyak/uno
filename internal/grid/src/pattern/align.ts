import { runes } from "../go/index.ts";

/**
 * maxDiff bounds the alignment. Two 128-character values cost 16,384 cells to
 * align, and a cell longer than that is prose rather than a field with a
 * convention in it -- there is no transformation to induce from a paragraph.
 */
export const MAX_DIFF = 128;

/** A stretch of characters the alignment says was removed or added. */
export interface Run {
  text: string;
  /** Code-point offset into the value it belongs to. */
  at: number;
}

export interface Alignment {
  dels: Run[];
  ins: Run[];
}

/**
 * align is a longest-common-subsequence diff, returning what was removed from a
 * and what was added from b, as runs rather than as characters: 1,204,567 has
 * two deletions of one comma, not two unrelated character events.
 *
 * It reports undefined for a pair too long to be worth aligning.
 */
export function align(a: string[], b: string[]): Alignment | undefined {
  if (a.length > MAX_DIFF || b.length > MAX_DIFF) return undefined;

  // lcs[i][j] is the length of the longest common subsequence of a[i:] and
  // b[j:], which lets the reconstruction below walk forwards.
  const lcs: number[][] = [];
  for (let i = 0; i <= a.length; i++) lcs.push(Array.from({ length: b.length + 1 }, () => 0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const dels: Run[] = [];
  const ins: Run[] = [];
  let d = "";
  let n = "";
  let dAt = 0;
  let nAt = 0;

  const flush = (): void => {
    if (d.length > 0) {
      dels.push({ text: d, at: dAt });
      d = "";
    }
    if (n.length > 0) {
      ins.push({ text: n, at: nAt });
      n = "";
    }
  };

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j === b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      if (d.length === 0) dAt = i;
      d += a[i]!;
      i++;
    } else {
      if (n.length === 0) nAt = j;
      n += b[j]!;
      j++;
    }
  }
  flush();

  return { dels, ins };
}

/** align over two strings, for callers that hold text rather than code points. */
export function alignText(was: string, now: string): Alignment | undefined {
  return align(runes(was), runes(now));
}
