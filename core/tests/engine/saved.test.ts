/**
 * @fileoverview A row index writes its block starts as delta varints and
 * reads them back as the same index, complete or taken partway, and the
 * scanner's index of a fixed file is pinned to INDEX_VERSION.
 */

import { expect, test } from 'vite-plus/test';

import { RowIndex, TUNING, indexPass } from '@engine';
import type { Tuning } from '@engine';
import { INDEX_VERSION, decodeBlocks, encodeBlocks } from '@engine/saved';
import { hashOf } from '@engine/grown';
import { openFormat } from '@ingest';
import { bytesSource } from '@store';
import { TINY } from './harness.ts';

const encoder = new TextEncoder();

/** The fixture's data rows. */
const FIXTURE_ROWS = 500;

/**
 * A file whose records the scanner must find past quoted delimiters, quoted
 * newlines, doubled quotes, CRLF endings and multi-byte characters.
 */
function fixture(): Uint8Array {
  const rows = ['id,name,note,amount\r\n'];
  for (let i = 0; i < FIXTURE_ROWS; i++) {
    const note = i % 3 === 0 ? `"line one\nline ""two"", ${i}"` : `naïve ${i}`;
    const end = i % 5 === 0 ? '\r\n' : '\n';
    rows.push(`${i},"Okafor, Ada",${note},${i * 7}.5${end}`);
  }
  return encoder.encode(rows.join(''));
}

/** indexed is the complete index of `bytes`, read by the pass under `tuning`. */
async function indexed(bytes: Uint8Array, tuning: Tuning): Promise<RowIndex> {
  const source = bytesSource(bytes);
  const format = await openFormat('fixture.csv', source);
  const index = new RowIndex(format.dataStart, source.size, tuning);
  await pass(bytes, index, tuning);
  return index;
}

/** pass runs the index pass over `bytes` from where `index` has scanned to. */
async function pass(
  bytes: Uint8Array,
  index: RowIndex,
  tuning: Tuning,
): Promise<void> {
  const source = bytesSource(bytes);
  const format = await openFormat('fixture.csv', source);
  const signal = new AbortController().signal;
  await indexPass({ source, format, index, tuning, signal, progress() {} });
}

/** blocks lists every block's rows and bytes. */
function blocks(index: RowIndex): Array<[number, number, number, number]> {
  return Array.from({ length: index.begun }, (_, b) => [
    ...index.rowsOf(b),
    ...index.bytesOf(b),
  ]);
}

/** restored is `index` written and read back, as complete or not. */
function restored(index: RowIndex, complete = index.complete) {
  const starts = decodeBlocks(encodeBlocks(index))!;
  const { start, size, counted } = index;
  return RowIndex.restored(start, size, TINY, starts, counted, complete);
}

/**
 * The hash of the blocks `INDEX_VERSION` makes of the fixture under TINY.
 * It changes only with the scanner or the block rule, and with it the
 * version.
 */
const GOLDEN = {
  version: 1,
  blocks: '754602693380b815f9434bde9edf59a16e2a7de46c44d0d70ee2ee2c6c7cbae6',
};

test('the scanner indexes a fixed file as INDEX_VERSION says', async () => {
  const index = await indexed(fixture(), TINY);
  expect(index.counted).toBe(FIXTURE_ROWS);
  expect(
    INDEX_VERSION,
    'a new INDEX_VERSION pins the hash its scanner makes with it',
  ).toBe(GOLDEN.version);
  expect(
    hashOf(encodeBlocks(index)),
    'the scanner or the block rule finds other blocks in the same bytes: bump INDEX_VERSION in core/src/engine/saved.ts and pin this hash with it',
  ).toBe(GOLDEN.blocks);
});

test('a complete index reads back as the same index', async () => {
  const index = await indexed(fixture(), TINY);
  const back = restored(index)!;
  expect(back.complete).toBe(true);
  expect(back.counted).toBe(index.counted);
  expect(back.scanned).toBe(index.size);
  expect(blocks(back)).toStrictEqual(blocks(index));
});

test('the index of a file with no rows reads as no index, so it is read afresh', async () => {
  const index = await indexed(encoder.encode('id,name\n'), TINY);
  expect(encodeBlocks(index)).toHaveLength(0);
  expect(restored(index)).toBeUndefined();
});

test('an index of one block reads back as one block', async () => {
  const index = await indexed(fixture(), TUNING);
  expect(index.begun).toBe(1);
  expect(blocks(restored(index)!)).toStrictEqual(blocks(index));
});

test('an index taken partway resumes from its last block to the index a pass from the start makes', async () => {
  const bytes = fixture();
  const whole = await indexed(bytes, TINY);
  const partway = new RowIndex(whole.start, whole.size, TINY);
  const scanner = (await openFormat('fixture.csv', bytesSource(bytes))).scanner(
    (offset) => partway.begin(offset),
  );
  const half = Math.floor(bytes.length / 2);
  scanner.push(bytes.subarray(whole.start, half), whole.start);
  partway.scanned = half;

  const back = restored(partway)!;
  const last = partway.begun - 1;
  expect(back.begun, 'every block but the last is kept').toBe(last);
  expect(back.scanned).toBe(partway.bytesOf(last)[0]);
  expect(back.counted).toBe(partway.rowsOf(last)[0]);
  expect(back.complete).toBe(false);
  await pass(bytes, back, TINY);
  expect(back.counted).toBe(whole.counted);
  expect(blocks(back)).toStrictEqual(blocks(whole));
});

test('offsets near 2^53 read back exactly', () => {
  const size = Number.MAX_SAFE_INTEGER;
  const start = size - 10_000;
  const index = new RowIndex(start, size, TINY);
  for (let offset = start; offset < size - 100; offset += 97) {
    index.begin(offset);
  }
  index.complete = true;
  expect(blocks(restored(index)!)).toStrictEqual(blocks(index));
});

test('bytes encodeBlocks could not have written read as no index', () => {
  const cut = encodeBlocks(new RowIndex(0, 1 << 20, TINY));
  expect(cut).toHaveLength(0);
  const half = Uint8Array.of(0x80);
  const odd = Uint8Array.of(0, 0, 1);
  const still = Uint8Array.of(0, 0, 0, 5);
  const beyond = Uint8Array.of(0, ...Array(8).fill(0xff), 0x7f);
  for (const bytes of [half, odd, still, beyond]) {
    expect(decodeBlocks(bytes)).toBeUndefined();
  }
});

test('block starts that are not an index of the file are refused', async () => {
  const index = await indexed(fixture(), TINY);
  const starts = decodeBlocks(encodeBlocks(index))!;
  const { start, size, counted } = index;
  const refused = [
    RowIndex.restored(start + 1, size, TINY, starts, counted, true),
    RowIndex.restored(
      start,
      starts.offsets.at(-1)!,
      TINY,
      starts,
      counted,
      true,
    ),
    RowIndex.restored(start, size, TINY, starts, starts.firsts.at(-1)!, true),
  ];
  expect(refused).toStrictEqual([undefined, undefined, undefined]);
});
