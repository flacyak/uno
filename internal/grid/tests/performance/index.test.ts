/**
 * @fileoverview Times the engine indexing a 96 MB file on disk, start to the
 * last row counted, and reading a page of rows through the index after it.
 * The file is written once to a folder of its own and removed at the end.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import { ROWS_AT_MOST, TUNING } from '@engine';
import { connect, indexed, openOne } from '@grid-tests/engine/harness';
import { diskProvider } from '@store/node';
import { ROWS, repeated } from '@grid-tests/testdata/sales-q3';
import { record } from '@grid-tests/efficiency/record';
import type { Metric } from '@grid-tests/efficiency/record';
import { fastest } from './time.ts';

/** 96 MB and 1,924,800 rows. */
const REPEATS = 400;
const SAMPLES = 3;

/** A row deep in the file, past anything the open read. */
const DEEP_ROW = Math.floor((REPEATS * ROWS) / 2);

let folder = '';
let path = '';
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'uno-performance-'));
  path = join(folder, 'big.csv');
  await writeFile(path, repeated(REPEATS));
});
afterAll(async () => {
  record('index', metrics, 'performance');
  await rm(folder, { recursive: true, force: true });
});

const metrics: Metric[] = [];

test('indexing 96 MB on disk, then reading a page deep in it', async () => {
  let rows = 0;
  let page = Infinity;
  const ms = await fastest(SAMPLES, async () => {
    const { engine, done } = connect(TUNING, [diskProvider()]);
    try {
      const src = await openOne(engine, { name: 'big.csv', path });
      await indexed(src);
      rows = src.progress.rows;
      // Read after the index is done, so the page's time is its own.
      const started = performance.now();
      const got = await src.rows(DEEP_ROW, ROWS_AT_MOST);
      page = Math.min(page, performance.now() - started);
      expect(got.rows).toHaveLength(ROWS_AT_MOST);
    } finally {
      done();
    }
  });
  expect(rows).toBe(REPEATS * ROWS);
  metrics.push(
    { name: 'index 96 MB on disk: ms', unit: 'ms', value: ms },
    {
      name: 'page of 2,000 rows deep in the file: ms',
      unit: 'ms',
      value: page,
    },
  );
});
