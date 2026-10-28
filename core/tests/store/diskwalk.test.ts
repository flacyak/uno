/**
 * @fileoverview Walking a folder on disk: every file under it at any depth, in
 * path order, paged by the last path a page held, against a real temp folder.
 */

import { readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import type { Listing, Walker } from '@store';
import { diskLister } from '@store/disklister';
import { byPartPath } from '@store/hive';

/** A page small enough that the tree below takes several. */
const SMALL_PAGE = 3;

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
  lister: Walker = diskLister(SMALL_PAGE),
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

test('a page holds at most its size, and names the last path it held as the next', async () => {
  const pages = await walked(root);

  expect(pages.map((p) => p.entries.length)).toEqual([
    SMALL_PAGE,
    SMALL_PAGE,
    SMALL_PAGE,
  ]);
  for (const page of pages.slice(0, -1))
    expect(page.next).toBe(page.entries.at(-1)!.name);
  expect(pages.at(-1)!.next, 'the last page says it is the last').toBe(
    undefined,
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

// A link back up the tree would be walked without end. A link elsewhere is
// walked as the folder it leads to.
test('a symlinked folder is followed, and one that loops back is passed over', async () => {
  const loops = join(outside, 'loops');
  await mkdir(join(loops, 'year=2025'), { recursive: true });
  await writeFile(join(loops, 'year=2025', 'part-0.csv'), 'x');
  await symlink(loops, join(loops, 'year=2025', 'again'));
  await symlink('.', join(loops, 'here'));
  await symlink(root, join(loops, 'linked'));

  const found = names(await walked(loops));

  expect(found).toContain('year=2025/part-0.csv');
  expect(found).toContain('linked/year=2024/month=9/part-0.csv');
  expect(found).toHaveLength(1 + FILES.length);
  expect(found.some((n) => n.startsWith('here/'))).toBe(false);
});

test('a root that is not there is a failure that names it', async () => {
  await expect(diskLister().walk(join(outside, 'never-made'))).rejects.toThrow(
    'never-made',
  );
});
