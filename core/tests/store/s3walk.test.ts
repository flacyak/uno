/**
 * @fileoverview Walking a bucket: every key under a prefix at any depth, paged
 * by the bucket's continuation token, against the stand-in.
 */

import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import type { Listing } from '@store';
import { s3Lister } from '@store/s3lister';
import { HOME_REGION } from './regions.ts';
import { BUCKET, KEYS, bucket } from './standin.ts';
import type { Bucket } from './standin.ts';

/** The one-byte body of most objects. */
const ONE = new Uint8Array([7]);

/** How many keys the dataset holds, two and a half pages of them. */
const KEYS_IN_DATASET = 2_500;

/** How many month folders the dataset's keys are spread over. */
const MONTHS = 12;

/** Digits in a part's number, so parts sort in the order made. */
const DIGITS = 4;

/** The key of the dataset's part `i`, in the month it falls in. */
function partKey(i: number): string {
  const month = (i % MONTHS) + 1;
  return `sales/year=2025/month=${month}/part-${String(i).padStart(DIGITS, '0')}.csv`;
}

/**
 * The bucket every check below walks: a dataset of 2,500 keys over twelve
 * month folders, and the folder markers a console leaves.
 */
function objects(): Map<string, Uint8Array> {
  const all = new Map<string, Uint8Array>([
    ['sales/', new Uint8Array()],
    ['sales/year=2025/', new Uint8Array()],
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
