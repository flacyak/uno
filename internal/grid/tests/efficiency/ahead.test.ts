// What indexing an object costs in bytes while somebody is reading it.
//
// Indexing reads the object once, front to back, with the next chunks asked
// for ahead. Alone, that fetches the object once. The measure here is what it
// fetches when a second reader is going through the same object in order at
// the same time, which is a person scrolling down, a find or a survey: every
// byte fetched past the object's own size and the blocks that reader needed is
// a byte asked for and thrown away.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Tuning } from "../../src/engine/index.ts";
import { indexed } from "../engine/harness.ts";
import { record } from "./record.ts";
import type { Metric } from "./record.ts";
import { remote, repeated } from "./remote.ts";
import type { Remote } from "./remote.ts";

/**
 * Small, so the 1.9 MB object is some 30 chunks and 600 blocks. What is
 * measured is a ratio, and it is the same at 8 MB chunks over 30 GB.
 */
const SMALL: Tuning = { ...TUNING, chunkBytes: 64 << 10, blockRows: 64, blockBytes: 4 << 10 };
const REPEATS = 8;
const OBJECT = repeated(REPEATS);

/** How many blocks the second reader reads for every chunk the index reads. */
const BLOCKS_PER_CHUNK = 2;
/** Where the second reader starts: past the rows the open itself read and kept. */
const FIRST_ROW = 4 * SMALL.blockRows;

/** The most the index may fetch of an object nobody else is reading, as a multiple of its size. */
const ALONE_BUDGET = 1.05;
/** The most it may fetch with a reader in order beside it. */
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
  // One read at a time, so the index has gone no further than the open needed
  // when the reader starts.
  const src = await door.during(r.open(), () => door.letLowest());

  // Each turn the reader takes its next blocks, then the one chunk the index
  // is waiting on is let through. Everything goes through nearest the front
  // first: the reader is behind the index, so its block is what goes when it
  // asks, and the index moves a chunk a turn.
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
