// Read-ahead over a range read that answers when the test says: what is asked
// for ahead, when, how much of it is out at once, and what happens to it when
// nobody reads it.

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
  // Going on from where it stopped: the next ones are asked for behind it, so
  // with the one it waited on, AHEAD were out.
  expect(r.asked).toEqual([0, 100, 200, 300, 400]);
  for (let at = 2 * CHUNK; at < SIZE; at += CHUNK) {
    expect((await read(at, CHUNK))[0], `the chunk at ${at}`).toBe(at / CHUNK);
  }
  // Every chunk asked for once, and nothing past the end.
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

// The grid fetches the rows on screen while indexing reads in order: those
// reads are served as asked, and the reader in order keeps its chunks.
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

// The grid draws blocks while indexing scans, and block k+1 starts where
// block k ended, so two blocks on screen look like a second reader in order.
// What was asked for ahead of the index is kept through that rather than let
// go, because the index goes on from exactly there a moment later and would
// otherwise ask for every chunk of it again.
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
  // The two blocks as asked, then only what the index had not been asked for
  // ahead yet: the chunks held for it were served, not asked for again.
  expect(r.asked.slice(5)).toEqual([750, 780, 500, 600]);
});

// The bound on work a scan is promised: every chunk of the object asked for
// once however often the grid draws consecutive blocks in the middle of it.
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

// Two readers in order at once: what was asked ahead for the first is held as
// long as the first is remembered, so the second reads as asked until the
// first has been forgotten, and then has its own chunks asked for. A chunk let
// go is asked for again if the first comes back for it.
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
  // The first going on again is asked for again, not served from what was let go.
  await read(2 * CHUNK, CHUNK);
  expect(r.asked.filter((a) => a === 2 * CHUNK)).toHaveLength(2);
});

// The task's bound: what read-ahead can hold, at the size indexing reads.
test("what read-ahead holds stays under 40 MB at the chunk size indexing reads", () => {
  expect(AHEAD * TUNING.chunkBytes).toBeLessThan(40 << 20);
});
