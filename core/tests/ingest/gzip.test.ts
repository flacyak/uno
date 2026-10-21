/**
 * @fileoverview The gzip inflater over the fixtures in testdata/gzip: what it
 * decodes against fflate, where it breaks, and its heads.
 */

import { Gunzip } from 'fflate';
import { describe, expect, test } from 'vite-plus/test';

import { BrokenStream, gunzipWhole, inflateHead } from '@ingest/gzip';
import { concat, differAt, fixture } from './bytes.ts';

/** The gzip fixtures: one of each shape a file comes in. */
const FIXTURES = [
  'sales-q3.csv.gz',
  'stored.gz',
  'members.csv.gz',
  'bgzf.csv.gz',
  'empty.gz',
];

/** A gzip trailer: the CRC, then the length. */
const CRC_BYTES = 4;
const TRAILER_BYTES = 8;

/** What fflate's streaming gunzip makes of every member. */
function fflate(stored: Uint8Array): Uint8Array {
  const pieces: Uint8Array[] = [];
  new Gunzip((piece) => pieces.push(piece)).push(stored, true);
  return concat(pieces);
}

/** The stored offset a BrokenStream names, from `run`. */
function brokenAt(run: () => unknown): number {
  try {
    run();
  } catch (err) {
    if (err instanceof BrokenStream) return err.at;
    throw err;
  }
  throw new Error('the stream inflated');
}

describe('a gzip file inflates', () => {
  test.each(FIXTURES)('%s to what fflate makes of it', (name) => {
    const stored = fixture(`gzip/${name}`);
    const want = fflate(stored);
    expect(differAt(gunzipWhole(stored), want)).toBe(-1);
  });

  test('the members of a file to the parts they were made from', () => {
    const parts = [1, 2, 3].map((n) => fixture(`sales-q3-part-${n}.csv`));
    const decoded = gunzipWhole(fixture('gzip/members.csv.gz'));
    expect(differAt(decoded, concat(parts))).toBe(-1);
  });

  test('past zero bytes after a member, which are padding', () => {
    const stored = fixture('gzip/members.csv.gz');
    const padded = concat([stored, new Uint8Array(3)]);
    expect(differAt(gunzipWhole(padded), gunzipWhole(stored))).toBe(-1);
  });
});

describe('a broken gzip file names the stored byte it breaks at', () => {
  const stored = fixture('gzip/members.csv.gz');
  /** Cuts in the first header, the first member's blocks, the last trailer. */
  const CUTS = [5, 1000, stored.length - CRC_BYTES];

  test.each(CUTS)('cut at %i', (cut) => {
    expect(brokenAt(() => gunzipWhole(stored.subarray(0, cut)))).toBe(cut);
  });

  test('with a damaged CRC in its last member, just past the CRC', () => {
    const crcAt = stored.length - TRAILER_BYTES;
    const damaged = stored.slice();
    damaged[crcAt]! ^= 1;
    expect(brokenAt(() => gunzipWhole(damaged))).toBe(crcAt + CRC_BYTES);
  });

  test('with bytes after a member that start no other', () => {
    const trailed = concat([stored, new Uint8Array([1, 2])]);
    expect(brokenAt(() => gunzipWhole(trailed))).toBeGreaterThan(stored.length);
  });
});

describe('a gzip head inflates', () => {
  const csv = fixture('sales-q3.csv');
  const stored = fixture('gzip/sales-q3.csv.gz');
  const LIMIT = 100_000;
  const CUT = 8 << 10;

  test('to a prefix of the file when its stored bytes are cut', () => {
    const head = inflateHead(stored.subarray(0, CUT), LIMIT);
    expect(head.ended).toBe(false);
    expect(head.bytes.length).toBeGreaterThan(CUT);
    expect(differAt(head.bytes, csv.subarray(0, head.bytes.length))).toBe(-1);
  });

  test('up to its limit, across members', () => {
    const head = inflateHead(fixture('gzip/bgzf.csv.gz'), LIMIT);
    expect(head.ended).toBe(false);
    expect(differAt(head.bytes, csv.subarray(0, LIMIT))).toBe(-1);
  });

  test.each(['sales-q3.csv.gz', 'members.csv.gz', 'empty.gz'])(
    'whole from %s when it fits the limit exactly',
    (name) => {
      const whole = gunzipWhole(fixture(`gzip/${name}`));
      const head = inflateHead(fixture(`gzip/${name}`), whole.length);
      expect(head.ended).toBe(true);
      expect(differAt(head.bytes, whole)).toBe(-1);
    },
  );
});
