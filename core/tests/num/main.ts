/**
 * @fileoverview parse as it was before its fast path, kept as written there,
 * so the tests can hold the fast path to it bit for bit and time the two.
 */

import { parseFloat as parseDecimal, trimSpace } from '@go';
import { signed, undress } from '@num';
import type { Mark } from '@num';

// The characters a value may hold once decoration is removed.
const ALLOWED = '0123456789+-.eE';

/** decimal reads `v` as a number written with `mark`. */
function decimal(v: string, mark: Mark): number | undefined {
  if (mark === 'comma') {
    if (v.includes('.')) return undefined;
    v = v.replaceAll(',', '.');
  }
  for (const r of v) {
    if (!ALLOWED.includes(r)) return undefined;
  }
  return parseDecimal(v);
}

/** mainParse is parse before its fast path. */
export function mainParse(v: string, mark: Mark): number | undefined {
  return decimal(signed(undress(trimSpace(v), mark)), mark);
}
