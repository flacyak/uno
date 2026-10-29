/**
 * @fileoverview Read-ahead end to end: an object indexed through the engine
 * from a bucket that adds 50 ms to every request, once one chunk at a time and
 * once with AHEAD chunks in flight.
 */

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import { TUNING } from '@engine';
import type { Tuning } from '@engine';
import { AHEAD } from '@store/ahead';
import { diskProvider } from '@store/node';
import { s3Provider } from '@store/s3';
import { HOME_REGION } from '@core-tests/store/regions';
import { BUCKET, KEYS, bucket } from '@core-tests/store/standin';
import type { Bucket } from '@core-tests/store/standin';
import { bytes, connect, indexed, openOne } from './harness.ts';

/** Milliseconds added to each request to the bucket. */
const LATENCY_MS = 50;
/**
 * How much of the latency read-ahead can hide must show as time saved. The
 * rest is left to the machine's load, which falls on both runs, but not
 * evenly.
 */
const SHOWN = 0.5;

/** The chunk size: small, so the object is about 120 chunks. */
const CHUNK = 16 << 10;
const SMALL: Tuning = { ...TUNING, chunkBytes: CHUNK };

/** The fixture's rows eight times over, under one header. */
const REPEATS = 8;
const BIG = ((): Uint8Array => {
  const header = bytes.indexOf(0x0a) + 1;
  const body = bytes.subarray(header);
  const out = new Uint8Array(header + body.length * REPEATS);
  out.set(bytes.subarray(0, header));
  for (let i = 0; i < REPEATS; i++) out.set(body, header + i * body.length);
  return out;
})();
const KEY = '2025/big.csv';

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, new Map([[KEY, BIG]]));
  b.latency = LATENCY_MS;
});
afterAll(() => b.close());

/** Indexed is one run: how long it took and what it sent. */
interface Indexed {
  ms: number;
  /** Reads of exactly the chunk size. */
  reads: number;
  /** The most of those out at once. */
  peak: number;
}

/**
 * indexing opens and indexes the object with `ahead` chunks in flight. Only
 * reads of exactly the chunk size are counted.
 */
async function indexing(ahead: number): Promise<Indexed> {
  let out = 0;
  let peak = 0;
  let reads = 0;
  const counted: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get('range');
    const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    const chunk = m !== null && Number(m[2]) - Number(m[1]) + 1 === CHUNK;
    if (chunk) {
      reads++;
      peak = Math.max(peak, ++out);
    }
    try {
      return await fetch(input, init);
    } finally {
      if (chunk) out--;
    }
  };
  const s3 = s3Provider({
    // Signed for the bucket's own region.
    credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
    endpoint: b.endpoint,
    fetch: counted,
    ahead,
  });
  const { engine, done } = connect(SMALL, [diskProvider(), s3]);
  try {
    const started = performance.now();
    const src = await openOne(engine, {
      name: 'big.csv',
      path: `s3://${BUCKET}/${KEY}`,
    });
    await indexed(src);
    return { ms: performance.now() - started, reads, peak };
  } finally {
    done();
  }
}

test('with 50 ms added per request, read-ahead hides most of the latency and holds at most four chunks', async () => {
  const one = await indexing(1);
  const four = await indexing(AHEAD);
  expect(one.reads, 'enough chunks to wait on').toBeGreaterThan(100);
  expect(one.peak, 'one at a time').toBe(1);
  // One at a time, every chunk read waits the latency in turn. AHEAD at a
  // time, all but one in every AHEAD wait under another's.
  const hidden = one.reads * LATENCY_MS * (1 - 1 / AHEAD);
  expect(one.ms - four.ms).toBeGreaterThanOrEqual(hidden * SHOWN);
  // At most AHEAD chunks out at once: under 40 MB at the default chunk size.
  expect(four.peak).toBe(AHEAD);
  expect(AHEAD * TUNING.chunkBytes).toBeLessThan(40 << 20);
}, 60_000);
