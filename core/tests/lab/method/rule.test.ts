/**
 * @fileoverview The reproduced rule says what PR #65's report says, on the
 * cases its own compare.test.ts checks and on rows its CI tables printed.
 */

import { expect, test } from 'vite-plus/test';

import { claimed, verdict } from './rule.ts';

test('a wall-clock change under five percent is noise, as in compare.test.ts', () => {
  expect(verdict('ms', 100, 104)).toBe('noise');
  expect(verdict('ms', 100, 96)).toBe('noise');
  expect(verdict('ms', 100, 106)).toBe('worse');
  expect(verdict('ms', 100, 90)).toBe('better');
  expect(verdict('ms', 60, 66)).toBe('worse');
});

test('missing and equal values are new, gone and same', () => {
  expect(verdict('ms', undefined, 1)).toBe('new');
  expect(verdict('ms', 1, undefined)).toBe('gone');
  expect(verdict('requests', 6, 6)).toBe('same');
});

test('any unit but "ms" is called on the smallest difference', () => {
  // index: scan time over a newline count, a ratio of two timings.
  expect(verdict('x', 1.68, 1.54)).toBe('better');
  // index: heap bytes kept per row, 0.01 then -0.33 on one CI run.
  expect(verdict('bytes', 0.01, -0.33)).toBe('better');
  expect(verdict('x', 1.01, 1.0)).toBe('better');
});

test('rows of the PR #65 efficiency table read as it printed them', () => {
  // index: scan ms per 200 MB, a change that touched no engine code.
  expect(verdict('ms', 389, 450)).toBe('worse');
  expect(verdict('ms', 124, 129)).toBe('noise');
  // A metric rounded to whole ms moves in steps of a whole ms.
  expect(verdict('ms', 1, 4)).toBe('worse');
});

test('only better and worse claim a change', () => {
  expect(claimed('better')).toBe(true);
  expect(claimed('worse')).toBe(true);
  expect(claimed('noise')).toBe(false);
  expect(claimed('same')).toBe(false);
  expect(claimed('new')).toBe(false);
});
