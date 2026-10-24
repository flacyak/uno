import { expect, test } from 'vite-plus/test';
import { RowIndex } from '@engine/rows';
import { random } from '../../../../scanner/shapes.ts';
import { BulkIndex as Base } from './base.ts';
import { BulkIndex as Gt } from './gt.ts';
import { BulkIndex as NoMin } from './nomin.ts';
import { BulkIndex as OffByOne } from './offbyone.ts';

import type { Begins } from '../../../../scanner/common.ts';
/** What every mutant shares; private fields make the classes distinct types. */
type Ctor = new (limits: { blockRows: number; blockBytes: number }) => {
  readonly counted: number;
  readonly blocks: number;
  beginMany(begins: Begins, count: number, base: number): void;
  firstRow(block: number): number;
  firstByte(block: number): number;
};
function wrong(Ctor: Ctor, garbage: number): boolean {
  for (let seed = 1; seed <= 3000; seed++) {
    const rand = random(seed + 99991);
    const limits = {
      blockRows: 1 + Math.floor(rand() * rand() * 40),
      blockBytes: 1 + Math.floor(rand() * rand() * 3000),
    };
    const offsets: number[] = [];
    let at = Math.floor(rand() * 100);
    for (let n = Math.floor(rand() * 2000); n > 0; n--) {
      offsets.push(at);
      at += 1 + Math.floor(rand() * rand() * 200);
    }
    const want = new RowIndex(0, at, limits);
    for (const o of offsets) want.begin(o);
    const got = new Ctor(limits);
    for (let k = 0; k < offsets.length;) {
      const count = Math.min(
        offsets.length - k,
        Math.floor(rand() * rand() * 300),
      );
      const base = (offsets[k] ?? 0) - 1;
      const b = new Float64Array(count + 8).fill(garbage);
      for (let j = 0; j < count; j++) b[j] = offsets[k + j]! - base;
      got.beginMany(b, count, base);
      k += count;
    }
    if (got.counted !== want.counted || got.blocks !== want['blocks'])
      return true;
    for (let i = 0; i < got.blocks; i++) {
      if (
        got.firstRow(i) !== want.rowsOf(i)[0] ||
        got.firstByte(i) !== want.bytesOf(i)[0]
      )
        return true;
    }
  }
  return false;
}
test('base agrees', () => {
  expect(wrong(Base, 1e15)).toBe(false);
  expect(wrong(Base, -1e15)).toBe(false);
});
test('gt caught', () => expect(wrong(Gt, 1e15)).toBe(true));
test('nomin caught with high garbage', () =>
  expect(wrong(NoMin, 1e15)).toBe(true));
test('nomin caught with low garbage (the lab test uses -1e9)', () =>
  expect(wrong(NoMin, -1e9)).toBe(true));
test('offbyone caught', () => expect(wrong(OffByOne, 1e15)).toBe(true));
