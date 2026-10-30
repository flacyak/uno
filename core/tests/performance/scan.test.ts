/**
 * @fileoverview Times each scanner alone over 96 MB held in memory: the CPU
 * cost of finding where records start, apart from any disk or engine. The
 * record scanner reads the sales fixture as CSV, and the line scanner reads
 * it as JSON Lines, an object per row.
 */

import { afterAll, expect, test } from 'vite-plus/test';

import { RecordScanner, readAll } from '@ingest';
import type { Scanner } from '@ingest';
import { LineScanner } from '@ingest/lines';
import { ROWS, bytes, repeated } from '@core-tests/testdata/sales-q3';
import { record } from '@core-tests/efficiency/record';
import type { Metric } from '@core-tests/efficiency/record';
import { fastest } from './time.ts';

/** 96 MB and 1,924,800 records. */
const REPEATS = 400;
/** 96 MB and 899,844 records, as JSON Lines. */
const LINE_REPEATS = 187;
/** The chunk size the engine's index pass reads at. */
const CHUNK = 8 << 20;
const SAMPLES = 5;

/** Bytes in a megabyte. */
const MB = 1 << 20;
/** Milliseconds in a second. */
const SECOND_MS = 1000;
/** The least MB per second the line scanner must manage. */
const LINES_FLOOR_MB_S = 300;

const metrics: Metric[] = [];
afterAll(() => record('scan', metrics, 'performance'));

/** scanAll pushes `data` through `scanner` a chunk at a time, as the index pass does. */
function scanAll(scanner: Scanner, data: Uint8Array): void {
  for (let at = 0; at < data.length; at += CHUNK) {
    scanner.push(data.subarray(at, Math.min(at + CHUNK, data.length)), at);
  }
}

/** The fixture's rows as JSON Lines, an object per row keyed by the header, `repeats` times over. */
function jsonLines(repeats: number): Uint8Array {
  const [header, ...rows] = readAll(new TextDecoder().decode(bytes), ',');
  const body = new TextEncoder().encode(
    rows
      .map((row) => {
        const fields = header!.map((name, i) => [name, row[i]]);
        return `${JSON.stringify(Object.fromEntries(fields))}\n`;
      })
      .join(''),
  );
  const out = new Uint8Array(body.length * repeats);
  for (let i = 0; i < repeats; i++) out.set(body, i * body.length);
  return out;
}

test('scanning 96 MB in memory', async () => {
  const data = repeated(REPEATS);
  let records = 0;
  const ms = await fastest(SAMPLES, async () => {
    records = 0;
    scanAll(new RecordScanner(',', () => records++), data);
  });
  // The header line is a record too.
  expect(records).toBe(REPEATS * ROWS + 1);
  metrics.push({ name: 'scan 96 MB in memory: ms', unit: 'ms', value: ms });
});

test('scanning 96 MB of JSON Lines in memory', async () => {
  const data = jsonLines(LINE_REPEATS);
  let records = 0;
  const ms = await fastest(SAMPLES, async () => {
    records = 0;
    scanAll(new LineScanner(() => records++), data);
  });
  expect(records).toBe(LINE_REPEATS * ROWS);
  metrics.push({
    name: 'scan 96 MB of JSON Lines in memory: ms',
    unit: 'ms',
    value: ms,
  });
  const rate = data.length / MB / (ms / SECOND_MS);
  expect(rate).toBeGreaterThanOrEqual(LINES_FLOOR_MB_S);
});
