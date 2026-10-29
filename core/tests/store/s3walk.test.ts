/**
 * @fileoverview Walking a bucket: every key under a prefix at any depth, paged
 * by the bucket's continuation token, against the stand-in.
 */

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import type { Listing } from '@store';
import { s3Files } from '@store/s3';
import { s3Lister } from '@store/s3lister';
import { HOME_REGION } from './regions.ts';
import { BUCKET, KEYS, MODIFIED, bucket, etagOf } from './standin.ts';
import type { Bucket } from './standin.ts';

/** The one-byte body of most objects. */
const ONE = new Uint8Array([7]);

/** How many keys the dataset holds, two and a half pages of them. */
const KEYS_IN_DATASET = 2_500;

/** How many month folders the dataset's keys are spread over. */
const MONTHS = 12;

/** Digits in a part's number, so parts sort in the order made. */
const DIGITS = 4;

/**
 * A partition value holding `%3A`, the escape Hive writes for ':'. The key
 * holds the three characters as written.
 */
const ESCAPED_HOUR = 'hour=2025-09-20 00%3A00%3A00';

/** The key of the dataset's part `i`, in the month it falls in. */
function partKey(i: number): string {
  const month = (i % MONTHS) + 1;
  return `sales/year=2025/month=${month}/part-${String(i).padStart(DIGITS, '0')}.csv`;
}

/**
 * The bucket every check below walks: a dataset of 2,500 keys over twelve
 * month folders, the folder markers a console leaves, a key with an escape in
 * its folder, and a sibling prefix the walk must leave out.
 */
function objects(): Map<string, Uint8Array> {
  const all = new Map<string, Uint8Array>([
    ['sales/', new Uint8Array()],
    ['sales/year=2025/', new Uint8Array()],
    ['sales-old/part-0000.csv', ONE],
    [`events/${ESCAPED_HOUR}/part-0000.csv`, ONE],
  ]);
  for (let i = 0; i < KEYS_IN_DATASET; i++) all.set(partKey(i), ONE);
  return all;
}

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, objects());
});
afterAll(() => b.close());

const lister = () =>
  s3Lister({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint });

/** pages walks `root` to its end and returns each page. */
async function pages(root: string): Promise<Listing[]> {
  const s3 = lister();
  const all: Listing[] = [];
  let cursor: string | undefined;
  do {
    const page = await s3.walk(root, cursor);
    all.push(page);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

// The two folder markers count toward a page's thousand keys too.
test('2,500 keys across partition folders are walked in three pages', async () => {
  const walked = await pages(`s3://${BUCKET}/sales/`);
  const names = walked.flatMap((p) => p.entries.map((e) => e.name));

  expect(walked).toHaveLength(3);
  expect(names.toSorted()).toEqual(
    Array.from({ length: KEYS_IN_DATASET }, (_, i) =>
      partKey(i).slice('sales/'.length),
    ).toSorted(),
  );
  expect(
    walked.flatMap((p) => p.entries).every((e) => !e.folder),
    'a walk holds files alone',
  ).toBe(true);
});

test('a walk sends no delimiter, so one request reaches every depth', async () => {
  b.seen.length = 0;
  await lister().walk(`s3://${BUCKET}/sales/`);
  const asked = b.seen.filter((r) => r.query?.includes('list-type') === true);

  expect(asked.at(-1)!.query).not.toContain('delimiter');
});

test("a walked key keeps its size, time and ETag, and its path is the handler's", async () => {
  const [first] = await pages(`s3://${BUCKET}/sales/`);
  const entry = first!.entries[0]!;

  expect(entry.bytes).toBe(ONE.length);
  expect(entry.modified).toEqual(new Date(MODIFIED));
  expect(entry.version).toBe(etagOf(ONE));
  expect(entry.path).toBe(`s3://${BUCKET}/sales/${entry.name}`);
});

// The folder markers would read as files named '' and 'year=2025/'.
test('the folder markers under the root are left out', async () => {
  const names = (await pages(`s3://${BUCKET}/sales/`)).flatMap((p) =>
    p.entries.map((e) => e.name),
  );

  expect(names).not.toContain('');
  expect(names).not.toContain('year=2025/');
});

test('a root with no slash at its end is a folder, so a sibling prefix is left out', async () => {
  const bare = await pages(`s3://${BUCKET}/sales`);
  const names = bare.flatMap((p) => p.entries.map((e) => e.name));

  expect(names).toHaveLength(KEYS_IN_DATASET);
  expect(names.some((n) => n.includes('sales-old'))).toBe(false);
  expect(names[0]!.startsWith('year=2025/')).toBe(true);
});

// Hive escapes ':' as %3A. The key holds those characters, so each '%' is
// sent as %25 in the query and in the path, and SigV4 signs it the same way.
test('a key holding %3A is walked, named and opened as written', async () => {
  const root = `s3://${BUCKET}/events/${ESCAPED_HOUR}/`;
  b.seen.length = 0;
  const { entries } = await lister().walk(root);

  expect(entries.map((e) => e.name)).toEqual(['part-0000.csv']);
  expect(b.seen.at(-1)!.query).toContain('00%253A00%253A00');

  const file = await s3Files({
    credentials: () => Promise.resolve(KEYS),
    endpoint: b.endpoint,
  }).open({ name: entries[0]!.name, path: entries[0]!.path });
  try {
    expect(await file.read(0, 1)).toEqual(ONE);
  } finally {
    await file.close();
  }
  expect(b.seen.at(-1)!.path).toContain('00%253A00%253A00/part-0000.csv');
});

test('a whole bucket is walked from its root', async () => {
  const names = (await pages(`s3://${BUCKET}`)).flatMap((p) =>
    p.entries.map((e) => e.name),
  );

  expect(names).toContain('sales-old/part-0000.csv');
  expect(names).toContain(`events/${ESCAPED_HOUR}/part-0000.csv`);
  expect(names).toHaveLength(KEYS_IN_DATASET + 2);
});

test('a walk of a missing bucket says so', async () => {
  await expect(lister().walk('s3://finance-lake/exports/')).rejects.toThrow(
    's3://finance-lake/exports/: no such bucket',
  );
});
