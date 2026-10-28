/**
 * @fileoverview The gzip inflater over the fixtures in testdata/gzip: what it
 * decodes against fflate, and where it breaks.
 */

import { Gunzip } from 'fflate';
import { describe, expect, test } from 'vite-plus/test';

import { BrokenStream, gunzipWhole } from '@ingest/gzip';
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
