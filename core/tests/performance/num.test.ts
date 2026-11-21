/**
 * @fileoverview Times parse against the full path it had before, kept in
 * core/tests/num/main.ts, over plain decimals such as a latitude. Every sum
 * and every number fold reads its cells through parse, so a plain decimal is
 * held to at least PARSE_SPEEDUP times as fast. Both run in the same process,
 * so a busy machine slows both alike.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import { parse } from '@num';
import type { Mark } from '@num';
import { record } from '@core-tests/efficiency/record';
import type { Metric } from '@core-tests/efficiency/record';
import { mainParse } from '@core-tests/num/main';

/** How many times as fast as the full path a plain decimal must read. */
const PARSE_SPEEDUP = 5;
/** Cells read per timed run, cycling through a mark's four. */
const CELLS = 400_000;
const SAMPLES = 7;

/** Four plain decimals in each mark: coordinates, an amount and a count. */
const PLAIN: Record<Mark, readonly string[]> = {
  point: ['40.712776', '-74.005974', '1204.50', '87'],
  comma: ['40,712776', '-74,005974', '1204,50', '87'],
};

const metrics: Metric[] = [];
afterAll(() => record('num', metrics, 'performance'));

/** The quickest of SAMPLES runs of `read` over CELLS cells, in ms. */
function quickest(
  read: (v: string, mark: Mark) => number | undefined,
  cells: readonly string[],
  mark: Mark,
): number {
  let best = Infinity;
  let numbers = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const started = performance.now();
    for (let i = 0; i < CELLS; i++)
      if (read(cells[i % cells.length]!, mark) !== undefined) numbers++;
    best = Math.min(best, performance.now() - started);
  }
  expect(numbers).toBe(SAMPLES * CELLS);
  return best;
}

for (const [mark, cells] of Object.entries(PLAIN) as Array<[Mark, string[]]>) {
  test(`parse reads a plain ${mark} decimal at least ${PARSE_SPEEDUP} times as fast`, () => {
    const before = quickest(mainParse, cells, mark);
    const after = quickest(parse, cells, mark);
    metrics.push(
      { name: `parse, ${mark}, 400,000 cells: ms`, unit: 'ms', value: after },
      {
        name: `parse, ${mark}, against main's: x`,
        unit: 'x',
        value: after / before,
      },
    );
    expect(before / after).toBeGreaterThanOrEqual(PARSE_SPEEDUP);
  });
}
