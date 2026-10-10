// Measures what a page after the first costs when listing a folder of 20,000
// files: directory entries read again, and wall-clock time. Only the entry
// count is held to a budget.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";

import { PAGE, diskLister } from "../../src/store/disklister.ts";
import { record } from "./record.ts";

/** Directory entries returned by every readdir so far. */
const read = vi.hoisted(() => ({ entries: 0 }));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  const readdir = async (...args: Parameters<typeof fs.readdir>) => {
    const found = await fs.readdir(...args);
    read.entries += found.length;
    return found;
  };
  return { ...fs, readdir };
});

/** Twenty pages of files. */
const FILES = 20_000;
/** How many pages are read after the first. */
const LATER_PAGES = 5;
/** Digits in a file's name, so names sort in the order made. */
const DIGITS = 6;

/** The most directory entries a page after the first may read from the disk. */
const ENTRIES_BUDGET = FILES;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uno-efficiency-"));
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(dir, `export-${String(i).padStart(DIGITS, "0")}.csv`), "");
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a page after the first reads little of the folder again", async () => {
  const lister = diskLister();
  const first = await lister.list(dir, undefined);
  expect(first.entries.length).toBe(PAGE);

  const before = read.entries;
  const took: number[] = [];
  let cursor = first.next;
  for (let page = 0; page < LATER_PAGES; page++) {
    const started = performance.now();
    const listing = await lister.list(dir, cursor);
    took.push(performance.now() - started);
    expect(listing.entries.length).toBe(PAGE);
    cursor = listing.next;
  }

  const entries = (read.entries - before) / LATER_PAGES;
  const median = took.toSorted((a, b) => a - b)[LATER_PAGES >> 1]!;
  record("lister", [
    { name: "folder of 20,000: entries read per later page", unit: "entries", value: entries },
    { name: "folder of 20,000: ms per later page (wall clock)", unit: "ms", value: median },
  ]);
  expect(entries).toBeLessThanOrEqual(ENTRIES_BUDGET);
}, 60_000);
