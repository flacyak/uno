/**
 * @fileoverview A fold a save wrote reads back as the fold it was, bit for
 * bit, so rows added after the reopen fold as they would have into the fold
 * before it.
 */

import { expect, test } from 'vite-plus/test';

import { ExactSum } from '@tally';
import { UINT32_RANGE, seeded } from '@core-tests/lab/cache/stats';

const SEEDS = 200;
const DRAWS = 48;
const HALF = DRAWS / 2;

/** throughJson is `v` as a save writes it and a reopen reads it. */
function throughJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/** bits returns doubles of every size and sign, from random bits. */
function bits(seed: number): number[] {
  const random = seeded(seed);
  const doubles = new Float64Array(DRAWS);
  const words = new Uint32Array(doubles.buffer);
  for (let i = 0; i < words.length; i++) words[i] = random() * UINT32_RANGE;
  return [...doubles].filter(Number.isFinite);
}

test('an exact sum read back from its save adds on as the sum it was', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const xs = bits(seed);
    const whole = new ExactSum();
    const before = new ExactSum();
    for (const x of xs) whole.add(x);
    for (const x of xs.slice(0, HALF)) before.add(x);
    const after = ExactSum.restored(throughJson(before.saved()))!;
    for (const x of xs.slice(HALF)) after.add(x);
    expect(after.saved(), `seed ${seed}`).toStrictEqual(whole.saved());
    expect(Object.is(after.value(), whole.value()), `seed ${seed}`).toBe(true);
  }
});

test('a save that holds no exact sum reads back as none', () => {
  const unsaved = [
    undefined,
    [],
    { partials: [1], units: 0.5 },
    { partials: [0], units: 0 },
    { partials: [2 ** 1023], units: 0 },
    { partials: ['1'], units: 0 },
  ];
  for (const v of unsaved) expect(ExactSum.restored(v)).toBeUndefined();
});
