// Measures the bytes fetched while indexing an object, alone and with a
// second reader going down the rows at the same time.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Tuning } from "../../src/engine/index.ts";
import { indexed } from "../engine/harness.ts";
import { record } from "./record.ts";
import type { Metric } from "./record.ts";
import { remote, repeated } from "./remote.ts";
import type { Remote } from "./remote.ts";

/**
 * Small chunks and blocks: the 1.9 MB object is about 30 chunks and 600
 * blocks.
 */
const SMALL: Tuning = { ...TUNING, chunkBytes: 64 << 10, blockRows: 64, blockBytes: 4 << 10 };
const REPEATS = 8;
const OBJECT = repeated(REPEATS);

/** How many blocks the second reader reads for every chunk the index reads. */
const BLOCKS_PER_CHUNK = 2;
/** The row the second reader starts at, past the rows the open already read. */
const FIRST_ROW = 4 * SMALL.blockRows;

/** The most the index alone may fetch, as a multiple of the object's size. */
const ALONE_BUDGET = 1.05;
/** The most it may fetch with a second reader beside it, as a multiple. */
const BESIDE_BUDGET = 1.85;

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const metrics: Metric[] = [];

test("indexing alone fetches the object about once", async () => {
  r = await remote(OBJECT, SMALL);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const { requests, bytes } = r.door.since(0);
  const times = bytes / OBJECT.length;
  metrics.push(
    { name: "index alone: bytes fetched per object byte", unit: "x", value: times },
    { name: "index alone: requests", unit: "requests", value: requests },
  );
  expect(times).toBeLessThanOrEqual(ALONE_BUDGET);
});

test("indexing beside a reader going down the rows stays within what it fetches today", async () => {
  r = await remote(OBJECT, SMALL);
  const door = r.door;
  // Reads are let through one at a time, lowest first, so the index is no
  // further than the open needed when the reader starts.
  const src = await door.during(r.open(), () => door.letLowest());

  // Each turn: the reader takes BLOCKS_PER_CHUNK blocks, then one more read is
  // let through for the index. Lowest offset goes first, so the reader's
  // block goes when it asks and the index moves one chunk a turn.
  for (let row = FIRST_ROW; !src.progress.complete;) {
    for (let i = 0; i < BLOCKS_PER_CHUNK; i++, row += SMALL.blockRows) {
      await door.during(src.rows(row, SMALL.blockRows), () => door.letLowest());
    }
    door.letLowest();
    await door.quiet();
  }

  const { requests, bytes } = r.door.since(0);
  const times = bytes / OBJECT.length;
  metrics.push(
    { name: "index beside a reader: bytes fetched per object byte", unit: "x", value: times },
    { name: "index beside a reader: requests", unit: "requests", value: requests },
  );
  record("ahead", metrics);
  expect(times).toBeLessThanOrEqual(BESIDE_BUDGET);
}, 60_000);
