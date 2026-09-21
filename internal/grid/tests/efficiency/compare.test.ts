/**
 * @fileoverview The Markdown table compare.ts builds.
 */

import { expect, test } from 'vite-plus/test';

import { compare, markdown } from './compare.ts';
import type { Metric } from './record.ts';

const BASE: Metric[] = [
  { name: 'band jump: requests', unit: 'requests', value: 6 },
  { name: 'open: bytes waited on', unit: 'bytes', value: 8_505_210 },
  { name: 'index: bytes fetched per object byte', unit: 'x', value: 1.84 },
  { name: 'page: ms', unit: 'ms', value: 60 },
  { name: 'dropped', unit: 'requests', value: 2 },
];
const HEAD: Metric[] = [
  { name: 'band jump: requests', unit: 'requests', value: 1 },
  { name: 'open: bytes waited on', unit: 'bytes', value: 8_505_210 },
  { name: 'index: bytes fetched per object byte', unit: 'x', value: 2.3 },
  { name: 'page: ms', unit: 'ms', value: 66 },
  { name: 'added', unit: 'entries', value: 0 },
];

test('each metric is set beside what it was, and said to be better, worse or the same', () => {
  expect(markdown(compare(BASE, HEAD), true)).toBe(
    [
      '### Efficiency',
      '',
      'What this change costs, beside the branch it is going into. Smaller is better.',
      '',
      '| Metric | Unit | Base | Head | Change |',
      '| --- | --- | ---: | ---: | --- |',
      '| band jump: requests | requests | 6 | 1 | better 83.3% |',
      '| open: bytes waited on | bytes | 8,505,210 | 8,505,210 | same |',
      '| index: bytes fetched per object byte | x | 1.84 | 2.3 | worse 25.0% |',
      '| page: ms | ms | 60 | 66 | worse 10.0% (wall clock) |',
      '| added | entries |  | 0 | new |',
      '| dropped | requests | 2 |  | gone |',
      '',
    ].join('\n'),
  );
});

test('with nothing to compare with, the table says so and still shows the numbers', () => {
  const table = markdown(compare([], HEAD.slice(0, 1)), false);
  expect(table).toContain('has no efficiency tests to compare with');
  expect(table).toContain('| band jump: requests | requests |  | 1 | new |');
});

test('a wall-clock change under five percent is noise, and a larger one is said', () => {
  const was: Metric[] = [{ name: 'scan: ms', unit: 'ms', value: 100 }];
  const rows = (now: number): string =>
    markdown(compare(was, [{ ...was[0]!, value: now }]), true, 'performance');
  expect(rows(104)).toContain(
    '| scan: ms | ms | 100 | 104 | within noise 4.0% (wall clock) |',
  );
  expect(rows(96)).toContain(
    '| scan: ms | ms | 100 | 96 | within noise 4.0% (wall clock) |',
  );
  expect(rows(106)).toContain(
    '| scan: ms | ms | 100 | 106 | worse 6.0% (wall clock) |',
  );
  expect(rows(90)).toContain(
    '| scan: ms | ms | 100 | 90 | better 10.0% (wall clock) |',
  );
});

test('a performance table is headed as one', () => {
  const table = markdown(
    compare([], [{ name: 'scan: ms', unit: 'ms', value: 1 }]),
    false,
    'performance',
  );
  expect(table).toContain('### Performance');
  expect(table).toContain(
    'What this change takes. The branch it is going into has no performance tests to compare with.',
  );
});
