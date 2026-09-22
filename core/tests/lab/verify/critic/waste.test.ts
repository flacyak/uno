/**
 * @fileoverview Counts, without timing anything, how many of the bucket
 * requests a band jump and a find send are read-ahead that no read takes.
 * A request is wasted when another request starts at the same offset with a
 * different length: readAhead guessed the next block's length from the last.
 */

import { afterEach, expect, test } from 'vite-plus/test';

import { BAND_ROWS } from '@engine/client';
import { TUNING } from '@engine';
import { indexed } from '@core-tests/engine/harness';
import { REGION, ROWS } from '@core-tests/testdata/sales-q3';
import { remote, repeated } from '@core-tests/efficiency/remote';
import type { Asked, Remote } from '@core-tests/efficiency/remote';

/** 24 MB and 481,200 rows, as the efficiency band test uses. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

/** wasted counts requests whose offset another request repeats at a different length. */
function wasted(sent: readonly Asked[]): number {
  const byOffset = new Map<number, Set<number>>();
  for (const a of sent) {
    if (a.offset === undefined) continue;
    const lengths = byOffset.get(a.offset) ?? new Set<number>();
    lengths.add(a.length);
    byOffset.set(a.offset, lengths);
  }
  let n = 0;
  for (const lengths of byOffset.values()) n += lengths.size - 1;
  return n;
}

test('a band jump: requests sent, and how many are unused read-ahead', async () => {
  r = await remote(OBJECT, TUNING);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const before = r.door.asked.length;
  const middle = (ROWS * REPEATS) >> 1;
  const reply = await r.door.during(src.rows(middle, BAND_ROWS));
  await r.door.quiet();
  expect(reply.rows.length).toBe(BAND_ROWS);
  const sent = r.door.asked.slice(before);
  const bytes = sent.reduce((s, a) => s + a.length, 0);
  process.stdout.write(
    `[critic] band: ${sent.length} requests, ${bytes} bytes, ${wasted(sent)} repeated at another length\n` +
      `[critic] band ranges: ${JSON.stringify(sent)}\n`,
  );
}, 60_000);

test('a find to the end: requests sent, and how many are unused read-ahead', async () => {
  r = await remote(OBJECT, TUNING);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const before = r.door.asked.length;
  const found = await r.door.during(
    src.find({
      col: REGION,
      from: 0,
      dir: 1,
      match: { t: 'text', text: 'nowhere' },
    }),
  );
  await r.door.quiet();
  expect(found.row).toBe(null);
  const sent = r.door.asked.slice(before);
  const bytes = sent.reduce((s, a) => s + a.length, 0);
  process.stdout.write(
    `[critic] find: ${sent.length} requests, ${bytes} bytes over ${OBJECT.length}, ${wasted(sent)} repeated at another length\n`,
  );
}, 120_000);
