/**
 * @fileoverview Times the record scanner alone over 96 MB held in memory: the
 * CPU cost of finding where records start, apart from any disk or engine.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import { RecordScanner } from '@ingest';
import { ROWS, repeated } from '@grid-tests/testdata/sales-q3';
import { record } from '@grid-tests/efficiency/record';
import type { Metric } from '@grid-tests/efficiency/record';
import { fastest } from './time.ts';

/** 96 MB and 1,924,800 records. */
const REPEATS = 400;
/** The chunk size the engine's index pass reads at. */
const CHUNK = 8 << 20;
const SAMPLES = 5;

const metrics: Metric[] = [];
afterAll(() => record('scan', metrics, 'performance'));

test('scanning 96 MB in memory', async () => {
  const data = repeated(REPEATS);
  let records = 0;
  const ms = await fastest(SAMPLES, async () => {
    records = 0;
    const scanner = new RecordScanner(',', () => records++);
    for (let at = 0; at < data.length; at += CHUNK) {
      scanner.push(data.subarray(at, Math.min(at + CHUNK, data.length)), at);
    }
  });
  // The header line is a record too.
  expect(records).toBe(REPEATS * ROWS + 1);
  metrics.push({ name: 'scan 96 MB in memory: ms', unit: 'ms', value: ms });
});
