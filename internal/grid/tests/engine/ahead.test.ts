// Read-ahead, end to end: an object indexed through the engine from a bucket
// every request to which takes 50 ms, once reading a chunk at a time and once
// with the next chunks asked for while the first is scanned.

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Tuning } from "../../src/engine/index.ts";
import { AHEAD } from "../../src/store/ahead.ts";
import { diskProvider } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { HOME_REGION } from "../store/regions.ts";
import { BUCKET, KEYS, bucket } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { bytes, connect, indexed, openOne } from "./harness.ts";

/** What each request to the bucket waits, as the task says. */
const LATENCY_MS = 50;
/** How much faster indexing has to be with read-ahead, as the task says. */
const FASTER = 3;

/**
 * The chunk indexing reads here: small, so the object is some 120 of them.
 * A real 30 GB object is 3,800, and the handful of requests every open makes
 * before indexing starts are what a short object would be measuring instead.
 */
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
const KEY = "2025/big.csv";

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, new Map([[KEY, BIG]]));
  b.latency = LATENCY_MS;
});
afterAll(() => b.close());

/**
 * How long indexing the object takes reading `ahead` chunks at a time, and the
 * most chunk reads that were out at once. A read of any other length is the
 * grid fetching its first rows, which read-ahead has nothing to do with.
 */
async function indexing(ahead: number): Promise<{ ms: number; peak: number }> {
  let out = 0;
  let peak = 0;
  const counted: typeof fetch = async (input, init) => {
    const range = new Headers(init?.headers).get("range");
    const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    const chunk = m !== null && Number(m[2]) - Number(m[1]) + 1 === CHUNK;
    if (chunk) peak = Math.max(peak, ++out);
    try {
      return await fetch(input, init);
    } finally {
      if (chunk) out--;
    }
  };
  const s3 = s3Provider({
    // Signed for the bucket's own region, as a connection that found it does.
    credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
    endpoint: b.endpoint,
    fetch: counted,
    ahead,
  });
  const { engine, done } = connect(SMALL, [diskProvider(), s3]);
  try {
    const started = performance.now();
    const src = await openOne(engine, { name: "big.csv", path: `s3://${BUCKET}/${KEY}` });
    await indexed(src);
    return { ms: performance.now() - started, peak };
  } finally {
    done();
  }
}

// The task's own sentence.
test("with 50 ms added per request, indexing is at least 3× faster and holds at most four chunks", async () => {
  expect(BIG.length / CHUNK, "enough chunks to wait on").toBeGreaterThan(100);

  const one = await indexing(1);
  const four = await indexing(AHEAD);
  expect(one.peak, "one at a time").toBe(1);
  expect(one.ms / four.ms).toBeGreaterThanOrEqual(FASTER);
  // Never more than AHEAD out at once, which is what bounds the memory: at
  // the chunk size indexing really reads, under 40 MB.
  expect(four.peak).toBe(AHEAD);
  expect(AHEAD * TUNING.chunkBytes).toBeLessThan(40 << 20);
}, 60_000);
