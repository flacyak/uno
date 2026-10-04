import { runes } from "../go/index.ts";

/** MAX_DIFF is the longest value `align` will diff, in code points. */
export const MAX_DIFF = 128;

/** A run of characters the alignment says was removed or added. */
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
 * align is a longest-common-subsequence diff. It returns the runs removed
 * from `a` and the runs added in `b`, with adjacent characters merged into one
 * run. Returns undefined when either side is longer than MAX_DIFF.
 */
export function align(a: string[], b: string[]): Alignment | undefined {
  if (a.length > MAX_DIFF || b.length > MAX_DIFF) return undefined;

  // lcs[i][j] is the LCS length of a[i:] and b[j:], so the reconstruction
  // below walks forwards.
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

/** alignText is `align` over two strings. */
export function alignText(was: string, now: string): Alignment | undefined {
  return align(runes(was), runes(now));
}
