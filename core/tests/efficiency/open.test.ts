/**
 * @fileoverview Measures the requests and bytes an open waits on before it
 * answers, and the requests when a listing gave the object's size and ETag.
 * Reads are let through one at a time, lowest offset first; what passed by
 * the time the open answered is what it waited on.
 */

import { afterAll, afterEach, expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import { record } from './record.ts';
import type { Metric } from './record.ts';
import { remote, repeated } from './remote.ts';
import type { Remote } from './remote.ts';

/** 24 MB: three chunks at the default chunk size. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

/** The most requests an open may wait on. */
const REQUESTS_BUDGET = 4;
/** The most bytes an open may wait on. */
const BYTES_BUDGET = 8_600_000;
/** The most requests an open of an object a listing named may wait on. */
const LISTED_REQUESTS_BUDGET = REQUESTS_BUDGET - 1;

/** Every number measured, written once the file has run. */
const metrics: Metric[] = [];
afterAll(() => record('open', metrics));

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

test('opening an object waits on its first rows and little else', async () => {
  r = await remote(OBJECT, TUNING);
  const door = r.door;
  await door.during(r.open(), () => door.letLowest());

  const { requests, bytes } = door.since(0, door.passed);
  metrics.push(
    { name: 'open: requests waited on', unit: 'requests', value: requests },
    { name: 'open: bytes waited on', unit: 'bytes', value: bytes },
  );
  expect(requests).toBeLessThanOrEqual(REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(BYTES_BUDGET);
}, 60_000);

// The size and ETag a listing gave stand in for the HEAD.
test('opening an object a listing named sends no HEAD', async () => {
  r = await remote(OBJECT, TUNING);
  const door = r.door;
  await door.during(r.openListed(), () => door.letLowest());

  const heads = door.asked.filter((a) => a.method === 'HEAD').length;
  const { requests } = door.since(0, door.passed);
  metrics.push({
    name: 'open of a listed object: requests waited on',
    unit: 'requests',
    value: requests,
  });
  expect(heads).toBe(0);
  expect(requests).toBeLessThanOrEqual(LISTED_REQUESTS_BUDGET);
}, 60_000);
