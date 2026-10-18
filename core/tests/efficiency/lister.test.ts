/**
 * @fileoverview Measures what a page after the first costs when listing a
 * folder of 20,000 files, and when walking a dataset of 10,000 files in 20
 * folders: directory entries read again, and wall-clock time. Only the entry
 * counts are held to a budget.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vite-plus/test';

import { PAGE, diskLister } from '@store/disklister';
import { record } from './record.ts';
import type { Metric } from './record.ts';

/** Directory entries returned by every readdir so far. */
const read = vi.hoisted(() => ({ entries: 0 }));

vi.mock('node:fs/promises', async (original) => {
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

/** The partition folders of the walked dataset. */
const DAYS = 20;
/** The files in each, half a page. */
const FILES_PER_DAY = PAGE / 2;

/**
 * The partition folders a later page of a walk reads: the one the cursor is
 * in, the two the page fills, and the one it looks into for the file past
 * the page.
 */
const FOLDERS_PER_WALK_PAGE = 4;

/**
 * The most directory entries a later page of a walk may read: the root's,
 * and those of the folders it reads.
 */
const WALK_ENTRIES_BUDGET = DAYS + FOLDERS_PER_WALK_PAGE * FILES_PER_DAY;

/** Every number measured, written once the file has run. */
const metrics: Metric[] = [];

let dir: string;
let dataset: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uno-efficiency-'));
  for (let i = 0; i < FILES; i++) {
    writeFileSync(
      join(dir, `export-${String(i).padStart(DIGITS, '0')}.csv`),
      '',
    );
  }
  dataset = mkdtempSync(join(tmpdir(), 'uno-efficiency-walk-'));
  for (let day = 1; day <= DAYS; day++) {
    const folder = join(dataset, `day=${day}`);
    mkdirSync(folder);
    for (let i = 0; i < FILES_PER_DAY; i++) {
      writeFileSync(
        join(folder, `part-${String(i).padStart(DIGITS, '0')}.csv`),
        '',
      );
    }
  }
});
afterAll(() => {
  record('lister', metrics);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataset, { recursive: true, force: true });
});

test('a page after the first reads little of the folder again', async () => {
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
  metrics.push(
    {
      name: 'folder of 20,000: entries read per later page',
      unit: 'entries',
      value: entries,
    },
    {
      name: 'folder of 20,000: ms per later page (wall clock)',
      unit: 'ms',
      value: median,
    },
  );
  expect(entries).toBeLessThanOrEqual(ENTRIES_BUDGET);
}, 60_000);

// A walk that started again from the root each page would read every folder
// before the cursor, so its later pages would cost more and more.
test('a later page of a walk reads only the folders on its path again', async () => {
  const lister = diskLister();
  let page = await lister.walk(dataset);
  const costs: number[] = [];
  while (page.next !== undefined) {
    const before = read.entries;
    page = await lister.walk(dataset, page.next);
    costs.push(read.entries - before);
  }

  const most = Math.max(...costs);
  metrics.push({
    name: 'dataset of 10,000 in 20 folders: entries read per later walk page',
    unit: 'entries',
    value: most,
  });
  expect(costs, 'every page after the first').toHaveLength(
    (DAYS * FILES_PER_DAY) / PAGE - 1,
  );
  expect(most).toBeLessThanOrEqual(WALK_ENTRIES_BUDGET);
}, 60_000);
