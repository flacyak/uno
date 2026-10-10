// readAhead over a range read the test controls: which chunks are asked for
// ahead, when, how many are out at once, and what happens to chunks left
// unread.

import { expect, test } from "vite-plus/test";

import { AHEAD, REMEMBERED, readAhead } from "../../src/store/ahead.ts";
import type { ReadRange } from "../../src/store/ahead.ts";
import { TUNING } from "../../src/engine/index.ts";

const CHUNK = 100;
const SIZE = 10 * CHUNK;

/** A read that remembers every range asked of it, and how many were out at once. */
function counting(fail?: number): {
  read: ReadRange;
  asked: number[];
  out: () => number;
  peak: () => number;
} {
  const asked: number[] = [];
  let out = 0;
  let peak = 0;
  const read: ReadRange = (offset, length) => {
    asked.push(offset);
    out++;
    peak = Math.max(peak, out);
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        out--;
        if (offset === fail) reject(new Error(`no range at ${offset}`));
        else resolve(new Uint8Array(length).fill(offset / CHUNK));
      }, 1),
    );
  };
  return { read, asked, out: () => out, peak: () => peak };
}

test("a reader going through in order has the next chunks asked for behind it", async () => {
  const r = counting();
  const read = readAhead(r.read, SIZE);
  await read(0, CHUNK);
  expect(r.asked, "one read is not yet an order").toEqual([0]);
  await read(CHUNK, CHUNK);
  // The second read in order starts read-ahead: AHEAD chunks were out,
  // counting the one awaited.
  expect(r.asked).toEqual([0, 100, 200, 300, 400]);
  for (let at = 2 * CHUNK; at < SIZE; at += CHUNK) {
    expect((await read(at, CHUNK))[0], `the chunk at ${at}`).toBe(at / CHUNK);
  }
  // Every chunk asked for once, ending at the last.
  expect(r.asked.toSorted((a, b) => a - b)).toEqual([
    0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
  ]);
  expect(r.peak()).toBeLessThanOrEqual(AHEAD);
});

test("the last chunk is asked for as long as the object has left", async () => {
  const r = counting();
  const size = 3 * CHUNK + 40;
  const read = readAhead(r.read, size);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  await read(2 * CHUNK, CHUNK);
  expect((await read(3 * CHUNK, 40)).length).toBe(40);
});

// Out-of-order reads are served as asked, and the in-order reader keeps its
// read-ahead.
test("reads out of order are read as asked and leave the reader in order alone", async () => {
  const r = counting();
  const read = readAhead(r.read, SIZE);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  const before = r.asked.length;
  await read(750, 30);
  await read(20, 10);
  expect(r.asked.slice(before), "only what was asked").toEqual([750, 20]);
  expect((await read(2 * CHUNK, CHUNK))[0], "and the next in order was already out").toBe(2);
  expect(r.asked.filter((a) => a === 2 * CHUNK)).toHaveLength(1);
});

test("a chunk asked for ahead that fails fails the read that wants it, and only that one", async () => {
  const r = counting(3 * CHUNK);
  const read = readAhead(r.read, SIZE);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  await read(2 * CHUNK, CHUNK);
  await expect(read(3 * CHUNK, CHUNK)).rejects.toThrow("no range at 300");
});

// Two consecutive out-of-order reads look like a second in-order reader. The
// chunks asked ahead for the first reader are kept through that.
test("the grid drawing two blocks in a row does not cost the index what was asked ahead of it", async () => {
  const r = counting();
  const read = readAhead(r.read, SIZE);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  expect(r.asked).toEqual([0, 100, 200, 300, 400]);
  await read(750, 30);
  await read(780, 30);
  await read(2 * CHUNK, CHUNK);
  await read(3 * CHUNK, CHUNK);
  // The two blocks as asked, then only the chunks still wanted ahead.
  expect(r.asked.slice(5)).toEqual([750, 780, 500, 600]);
});

// A full scan asks for every chunk once, with pairs of out-of-order reads in
// the middle of it.
test("a scan with the grid drawing in the middle of it asks for every chunk once", async () => {
  const r = counting();
  const read = readAhead(r.read, SIZE);
  const blocks = [750, 780, 810, 840];
  let drawn = 0;
  for (let at = 0; at < SIZE; at += CHUNK) {
    await read(at, CHUNK);
    if (at === 2 * CHUNK || at === 5 * CHUNK) {
      await read(blocks[drawn++]!, 30);
      await read(blocks[drawn++]!, 30);
    }
  }
  expect(r.asked.filter((a) => a % CHUNK === 0).toSorted((a, b) => a - b)).toEqual([
    0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
  ]);
  expect(r.asked).toHaveLength(SIZE / CHUNK + blocks.length);
});

// Two in-order readers: the second reads as asked until the first is
// forgotten, after REMEMBERED reads, then gets read-ahead of its own. The
// first reader's chunks are let go, and asked for again if it comes back.
test("a second reader in order gets its chunks once the first is forgotten, and the first's are let go", async () => {
  const r = counting();
  const size = 20 * CHUNK;
  const read = readAhead(r.read, size);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  expect(r.asked).toEqual([0, 100, 200, 300, 400]);
  await read(1000, CHUNK);
  await read(1100, CHUNK);
  expect(r.asked.slice(-2), "the first is still remembered, so nothing is asked ahead").toEqual([
    1000, 1100,
  ]);
  for (let at = 1200; at < 1200 + REMEMBERED * CHUNK; at += CHUNK) await read(at, CHUNK);
  expect(r.peak()).toBeLessThanOrEqual(AHEAD);
  expect(
    r.asked.at(-1)!,
    "the first forgotten, the second has chunks asked ahead of it",
  ).toBeGreaterThan(1200 + REMEMBERED * CHUNK);
  // The first reader's next chunk is asked for again.
  await read(2 * CHUNK, CHUNK);
  expect(r.asked.filter((a) => a === 2 * CHUNK)).toHaveLength(2);
});

test("a reader that has gone is not asked ahead for again at every read from elsewhere", async () => {
  const r = counting();
  const size = 20 * CHUNK;
  const read = readAhead(r.read, size);
  for (let at = 0; at < 5 * CHUNK; at += CHUNK) await read(at, CHUNK);
  const scanned = r.asked.length;
  // Scattered reads cost one request each, with the forgotten scan left alone.
  const elsewhere = [1500, 900, 1700, 1100, 1900, 1300, 800, 1600];
  for (const at of elsewhere) await read(at, CHUNK);
  expect(r.asked.length - scanned).toBe(elsewhere.length);
});

// The memory bound of read-ahead at the chunk size indexing uses.
test("what read-ahead holds stays under 40 MB at the chunk size indexing reads", () => {
  expect(AHEAD * TUNING.chunkBytes).toBeLessThan(40 << 20);
});
