/**
 * @fileoverview Walking a folder on disk: every file under it at any depth, in
 * path order, against a real temp folder.
 */

import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import type { Listing, Walker } from '@store';
import { diskLister } from '@store/disklister';
import { byPartPath } from '@store/hive';

/**
 * The files of the tree every check walks, by path under its root: partition
 * folders with month=9 beside month=10, files beside folders, an empty
 * folder's sibling, and the leftovers a job writes, which a walk still lists.
 */
const FILES = [
  'year=2024/month=10/part-0.csv',
  'year=2024/month=9/part-0.csv',
  'year=2024/month=9/part-1.csv',
  'year=2024/month=1/part-0.csv',
  'year=2025/month=1/part-0.csv',
  'year=2025/_SUCCESS',
  'readme.txt',
  '.hidden.csv',
  'a.csv',
];

let outside: string;
let root: string;
beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), 'uno-walk-'));
  root = join(outside, 'sales');
  for (const path of FILES) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  await mkdir(join(root, 'year=2026'));
});
afterAll(() => rm(outside, { recursive: true, force: true }));

/** walked walks `at` to its end, page by page, and returns each page. */
async function walked(
  at: string,
  lister: Walker = diskLister(),
): Promise<Listing[]> {
  const pages: Listing[] = [];
  let cursor: string | undefined;
  do {
    const page = await lister.walk(at, cursor);
    pages.push(page);
    cursor = page.next;
  } while (cursor !== undefined);
  return pages;
}

/** names is every entry's name across the pages, in order. */
function names(pages: readonly Listing[]): string[] {
  return pages.flatMap((p) => p.entries.map((e) => e.name));
}

/** filesIn is every file under `at` from one recursive readdir, by path under it. */
function filesIn(at: string): string[] {
  return readdirSync(at, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(at, join(e.parentPath, e.name)).split(sep).join('/'));
}

test('every file under the root comes back in the order byPartPath sorts them', async () => {
  const pages = await walked(root);

  expect(names(pages)).toEqual(filesIn(root).toSorted(byPartPath));
  expect(names(pages).indexOf('year=2024/month=9/part-1.csv')).toBeLessThan(
    names(pages).indexOf('year=2024/month=10/part-0.csv'),
  );
});

test("a walked file carries its size and time, and its path is the file's", async () => {
  const [first] = await walked(root, diskLister());
  const entry = first!.entries.find((e) => e.name === 'readme.txt')!;

  expect(first!.entries.every((e) => !e.folder)).toBe(true);
  expect(entry.bytes).toBe('readme.txt'.length);
  expect(entry.modified).toBeInstanceOf(Date);
  expect(await readFile(entry.path, 'utf8')).toBe('readme.txt');
});

test('a root that is not there is a failure that names it', async () => {
  await expect(diskLister().walk(join(outside, 'never-made'))).rejects.toThrow(
    'never-made',
  );
});
