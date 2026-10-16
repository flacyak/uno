/**
 * @fileoverview The lab's sessions measure what they say: the kept-index
 * session serves the same rows as the engine and sends the same band reads,
 * an open today costs the same the second time, a store of pages turns a
 * second open into one HEAD, and the bucket on its worker serves the engine.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { BAND_ROWS, TUNING } from '@engine';
import type { Tuning } from '@engine';
import { HOME_REGION } from '@core-tests/store/regions';
import { bucket } from '@core-tests/store/standin';
import type { Bucket } from '@core-tests/store/standin';
import { ROWS, repeated } from '@core-tests/testdata/sales-q3';
import { memoryBytes } from './cache.ts';
import { diskBytes } from './disk.ts';
import { KEY, farBucket } from './far.ts';
import {
  engineSession,
  jumpRows,
  keptSession,
  watched,
  wholeIndex,
} from './session.ts';
import type { Reach } from './session.ts';
import { Tally } from './tally.ts';

/** 2.4 MB and 48,120 rows: enough for several chunks at a small chunk size. */
const REPEATS = 10;
const OBJECT = repeated(REPEATS);
const JUMPS = 20;
/** Small chunks, so the object is a few dozen of them. */
const SMALL: Tuning = { ...TUNING, chunkBytes: 64 << 10 };
/** Pages small enough that a band spans a few. */
const PAGE_BYTES = 32 << 10;
/** A budget the object fits in. */
const ROOMY = 64 << 20;

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, new Map([[KEY, OBJECT]]));
});
afterAll(() => b.close());

const reach = (keep?: Reach['keep']): Reach => ({
  endpoint: b.endpoint,
  tally: new Tally(),
  keep,
});

describe('jumpRows', () => {
  test('lands every band inside the rows, each once, none after the one before', () => {
    const rows = ROWS * REPEATS;
    const jumps = jumpRows(rows, JUMPS);
    expect(new Set(jumps).size).toBe(JUMPS);
    for (const first of jumps) {
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first + BAND_ROWS).toBeLessThanOrEqual(rows);
    }
    for (let i = 1; i < JUMPS; i++) {
      expect(jumps[i]).not.toBe(jumps[i - 1]! + BAND_ROWS);
    }
  });
});

describe('sessions', () => {
  const jumps = jumpRows(ROWS * REPEATS, JUMPS);

  test('an open today costs the same the second time', async () => {
    const first = await engineSession(reach(), SMALL, jumps);
    const second = await engineSession(reach(), SMALL, jumps);
    expect(first.rows).toBe(ROWS * REPEATS);
    // Read-ahead goes on sending while the open infers its columns, so where
    // the open ends and the index begins is down to timing: a cold first
    // open can answer a few chunks later. The scan as a whole sends the same.
    const cost = (s: typeof first) => ({
      scan: [s.open.requests + s.index.requests, s.open.bytes + s.index.bytes],
      bands: [s.bands.requests, s.bands.bytes],
    });
    expect(cost(second)).toEqual(cost(first));
    // Every byte of the object is asked for by the scan.
    expect(first.open.bytes + first.index.bytes).toBeGreaterThan(OBJECT.length);
  });

  test('with the index kept, the open sends no chunk and the bands send what they did', async () => {
    const kept = await wholeIndex(OBJECT, SMALL);
    const today = await engineSession(reach(), SMALL, jumps);
    const keeping = await keptSession(reach(), SMALL, kept, jumps);
    expect(keeping.rows).toBe(today.rows);
    // The HEAD, the sniff of the head, and the sample rows' block.
    const OPEN_REQUESTS = 3;
    expect(keeping.open.requests).toBeLessThanOrEqual(OPEN_REQUESTS);
    expect(keeping.open.bytes).toBeLessThan(SMALL.chunkBytes * 2);
    // The same blocks are read, and nothing ahead of them.
    expect(keeping.bands.requests).toBe(today.bands.requests);
    expect(keeping.bands.bytes).toBe(today.bands.bytes);
  });

  test('with pages kept, a second open is one HEAD and the same rows', async () => {
    const store = watched(memoryBytes(ROOMY));
    const keep = { store, pageBytes: PAGE_BYTES };
    const first = await engineSession(reach(keep), SMALL, jumps);
    await store.idle();
    const second = await engineSession(reach(keep), SMALL, jumps);
    expect(second.rows).toBe(first.rows);
    expect(second.open.requests + second.index.requests).toBe(1);
    expect(second.bands.requests).toBe(0);

    const kept = await wholeIndex(OBJECT, SMALL);
    const both = await keptSession(reach(keep), SMALL, kept, jumps);
    expect(both.open.requests + both.bands.requests).toBe(1);
  });
});

describe('pages on disk within a budget', () => {
  let dir = '';
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test('a folder filled by an engine stays within its budget', async () => {
    const BUDGET = 16 * PAGE_BYTES;
    dir = await mkdtemp(join(tmpdir(), 'uno-lab-remote-'));
    const store = watched(diskBytes(dir, BUDGET));
    const keep = { store, pageBytes: PAGE_BYTES };
    const jumps = jumpRows(ROWS * REPEATS, JUMPS);
    await engineSession(reach(keep), SMALL, jumps);
    await store.idle();
    const names = await readdir(dir);
    const sizes = await Promise.all(
      names.map(async (n) => (await stat(join(dir, n))).size),
    );
    expect(sizes.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(BUDGET);
  });
});

describe('farBucket', () => {
  test('serves the engine from its own thread, with the latency it is given', async () => {
    const LATENCY_MS = 30;
    const far = await farBucket(REPEATS);
    try {
      await far.latency(LATENCY_MS);
      const tally = new Tally();
      const s = await engineSession(
        { endpoint: far.endpoint, tally },
        SMALL,
        jumps(),
      );
      expect(s.rows).toBe(ROWS * REPEATS);
      // The HEAD alone waits the latency once.
      expect(s.open.ms).toBeGreaterThanOrEqual(LATENCY_MS);
    } finally {
      await far.close();
    }
  }, 30_000);

  const jumps = (): number[] => jumpRows(ROWS * REPEATS, 1);
});
