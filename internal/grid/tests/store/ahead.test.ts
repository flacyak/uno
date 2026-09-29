// Read-ahead over a range read that answers when the test says: what is asked
// for ahead, when, how much of it is out at once, and what happens to it when
// nobody reads it.

import { expect, test } from "vite-plus/test";

import { AHEAD, readAhead } from "../../src/store/ahead.ts";
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

// Two readers in order at once: the one that went on last has its chunks
// asked for, and what was held for the other is let go rather than kept
// against the bound. A chunk let go is asked for again if it is wanted.
test("a second reader in order takes over, and what was held for the first is let go", async () => {
  const r = counting();
  const read = readAhead(r.read, SIZE);
  await read(0, CHUNK);
  await read(CHUNK, CHUNK);
  expect(r.asked).toEqual([0, 100, 200, 300, 400]);
  await read(600, CHUNK);
  await read(700, CHUNK);
  expect(r.asked.slice(-3)).toEqual([700, 800, 900]);
  // The first going on again is asked for again, not served from what was let go.
  await read(2 * CHUNK, CHUNK);
  expect(r.asked.filter((a) => a === 2 * CHUNK)).toHaveLength(2);
});

// The task's bound: what read-ahead can hold, at the size indexing reads.
test("what read-ahead holds stays under 40 MB at the chunk size indexing reads", () => {
  expect(AHEAD * TUNING.chunkBytes).toBeLessThan(40 << 20);
});
