/**
 * @fileoverview The A/A schedule and the counting of false claims, on made-up
 * runs whose answers are known.
 */

import { expect, test } from 'vite-plus/test';

import { judge, schedule, spreads } from './aa.ts';
import type { Values } from './aa.ts';

const SCAN = 'scan 96 MB in memory: ms';
const RATIO = 'scan over count';

function run(scanMs: number, ratio: number): Values {
  return new Map([
    [SCAN, { unit: 'ms', value: scanMs }],
    [RATIO, { unit: 'x', value: ratio }],
  ]);
}

test('sequential runs every head before every base, as the workflow does', () => {
  expect(schedule('sequential', 3).map((s) => `${s.role}${s.pair}`)).toEqual([
    'head0',
    'head1',
    'head2',
    'base0',
    'base1',
    'base2',
  ]);
});

test('interleaved alternates head and base, pair by pair', () => {
  expect(schedule('interleaved', 2).map((s) => `${s.role}${s.pair}`)).toEqual([
    'head0',
    'base0',
    'head1',
    'base1',
  ]);
});

test('each pair is judged by the rule, and a table with any claim is counted', () => {
  const heads = [run(100, 1.5), run(110, 1.5), run(100, 1.6)];
  const bases = [run(102, 1.5), run(100, 1.5), run(100, 1.5)];
  const verdict = judge(heads, bases);

  expect(verdict.pairs).toBe(3);
  // Pair 1 claims scan worse by 10%, pair 2 claims the ratio worse.
  expect(verdict.tablesWithAClaim).toBe(2);
  const scan = verdict.metrics[SCAN]!;
  expect(scan.calls).toMatchObject({ noise: 1, worse: 1, same: 1 });
  expect(scan.claimedPct).toBeCloseTo(100 / 3);
  expect(scan.maxAbsChangePct).toBeCloseTo(10);
  expect(scan.pooledMin).toBe('same');
  expect(scan.pooledMedian).toBe('same');
  const ratio = verdict.metrics[RATIO]!;
  expect(ratio.calls).toMatchObject({ same: 2, worse: 1 });
});

test('a drift that lands on one side shows in the median change', () => {
  const heads = [run(110, 1), run(111, 1)];
  const bases = [run(100, 1), run(101, 1)];
  const scan = judge(heads, bases).metrics[SCAN]!;
  expect(scan.medianChangePct).toBeGreaterThan(9);
  expect(scan.pooledMin).toBe('worse');
});

test('heads and bases must pair one to one', () => {
  expect(() => judge([run(1, 1)], [])).toThrow('cannot pair');
});

test('spreads summarize each metric over runs of one commit', () => {
  const s = spreads([run(100, 1), run(110, 1), run(105, 1)])[SCAN]!;
  expect(s).toMatchObject({ unit: 'ms', n: 3, min: 100, median: 105 });
  expect(s.p95AbsPairChangePct).toBeGreaterThan(9);
});
