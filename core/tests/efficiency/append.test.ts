/**
 * @fileoverview Measures the requests and bytes an append of one file to an
 * indexed source of several files in a bucket asks for.
 */

import { afterEach, expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import type { SingleRef } from '@store';
import { indexed, openOne } from '@core-tests/engine/harness';
import { BUCKET } from '@core-tests/store/standin';
import { ROWS } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
import { repeated, served } from './remote.ts';
import type { Served } from './remote.ts';

/** 2.4 MB and 48,120 rows in every file. */
const REPEATS = 10;
const FILE = repeated(REPEATS);

/** How many files the source opens with, before one more is appended. */
const OPENED = 3;

/** The most requests an append may send. */
const REQUESTS_BUDGET = 19;
/**
 * The most bytes an append may ask for: the new file, and every file the
 * source had, which it indexes again.
 */
const BYTES_BUDGET = 10_100_000;

/** Where the files are in the bucket. */
const FOLDER = 'exports';

let s: Served | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('appending a file to a source of several files reads every file again', async () => {
  const files = Array.from({ length: OPENED + 1 }, (_, i): SingleRef => {
    const name = `export-${i + 1}.csv`;
    return { name, path: `s3://${BUCKET}/${FOLDER}/${name}` };
  });
  const objects = files.map((f) => [`${FOLDER}/${f.name}`, FILE] as const);
  s = await served(new Map(objects), TUNING);
  const door = s.door;
  const parts = files.slice(0, OPENED).map((ref) => ({ ref }));
  const before = await door.during(
    openOne(s.engine, { name: FOLDER, parts, header: 'first' }),
  );
  await door.during(indexed(before));
  await door.quiet();

  const from = door.asked.length;
  const src = await door.during(s.engine.append(before, [files[OPENED]!]));
  await door.during(indexed(src));
  await door.quiet();
  expect(src.progress.rows).toBe(ROWS * REPEATS * files.length);

  const { requests, bytes } = door.since(from);
  record('append', [
    { name: 'append: requests', unit: 'requests', value: requests },
    { name: 'append: bytes asked for', unit: 'bytes', value: bytes },
  ]);
  expect(requests).toBeLessThanOrEqual(REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(BYTES_BUDGET);
}, 60_000);
