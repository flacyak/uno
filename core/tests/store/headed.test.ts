/**
 * @fileoverview A source behind a head already read answers the reads inside
 * the head from it, and passes the rest to the source.
 */

import { expect, test } from 'vite-plus/test';

import { headed } from '@store';
import type { ByteSource } from '@store';

const FILE = new TextEncoder().encode('date,units\n2026-07-01,1204\n');

/** The header row's length, newline and all. */
const HEADER_BYTES = 'date,units\n'.length;

/** A source over FILE, and every read it was asked for. */
function watched(): { source: ByteSource; reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  const source: ByteSource = {
    size: FILE.length,
    version: '"etag"',
    read: (offset, length) => {
      reads.push([offset, length]);
      return Promise.resolve(FILE.subarray(offset, offset + length));
    },
    close: () => Promise.resolve(),
  };
  return { source, reads };
}

test('a read inside the head is answered from it, and one past it from the source', async () => {
  const { source, reads } = watched();
  const head = headed(source, FILE.subarray(0, HEADER_BYTES));
  expect(head.size).toBe(FILE.length);
  expect(head.version).toBe(source.version);

  expect(await head.read(0, HEADER_BYTES)).toEqual(
    FILE.subarray(0, HEADER_BYTES),
  );
  expect(await head.read(5, 4)).toEqual(FILE.subarray(5, 9));
  expect(reads).toEqual([]);

  expect(await head.read(0, HEADER_BYTES + 1)).toEqual(
    FILE.subarray(0, HEADER_BYTES + 1),
  );
  expect(reads).toEqual([[0, HEADER_BYTES + 1]]);
});

test('a head that holds the whole file answers a read past its end', async () => {
  const { source, reads } = watched();
  const head = headed(source, FILE);
  expect(await head.read(0, 2 * FILE.length)).toEqual(FILE);
  expect(reads).toEqual([]);
});
