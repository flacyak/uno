/**
 * @fileoverview Times a time fold's snapshot and each batch after it, for a
 * full summed fold at the bound, which is the most a snapshot regroups. The
 * suite records the times for the report, as the other performance suites
 * do, and checks only the fold it times.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import { HELD_AT_MOST, LEVEL_BATCH, TimeFold } from '@tally';
import { record } from '@core-tests/efficiency/record';
import type { Metric } from '@core-tests/efficiency/record';
import { fastest } from './time.ts';

const SAMPLES = 5;
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
/** The periods a fold is timed holding, and the minutes between them. */
const TIMED = ['hour', 'day'] as const;
type Timed = (typeof TIMED)[number];
const STEPS: Record<Timed, number> = { hour: HOUR_MINUTES, day: DAY_MINUTES };

const metrics: Metric[] = [];
afterAll(() => record('snapshot', metrics, 'performance'));

/**
 * A fold summing HELD_AT_MOST periods at `held`, two rows each, at its start
 * and halfway through, so a fold of days has passed the bound in hours.
 */
function full(held: Timed): TimeFold {
  const fold = new TimeFold('day', 'point');
  const step = STEPS[held];
  for (let i = 0; i < HELD_AT_MOST; i++) {
    for (const m of [0, step / 2]) {
      const iso = new Date((i * step + m) * MINUTE_MS).toISOString();
      fold.add(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`, `${i}.37`);
    }
  }
  expect(fold.read()).toMatchObject({ held });
  return fold;
}

for (const held of TIMED) {
  test(`a full summed fold of ${held}s snapshots and batches`, async () => {
    const fold = full(held);
    const snapshot = await fastest(SAMPLES, async () => {
      fold.snapshot(held);
    });
    const [finest] = fold.snapshot(held).levels;
    expect(finest!.span).toBeGreaterThan(LEVEL_BATCH);
    let slowest = 0;
    for (let at = LEVEL_BATCH; at < finest!.span; at += LEVEL_BATCH) {
      const batch = await fastest(SAMPLES, async () => {
        fold.batch(held, at);
      });
      slowest = Math.max(slowest, batch);
    }
    metrics.push(
      {
        name: `snapshot, ${held}s at the bound: ms`,
        unit: 'ms',
        value: snapshot,
      },
      {
        name: `slowest batch, ${held}s at the bound: ms`,
        unit: 'ms',
        value: slowest,
      },
    );
  });
}
