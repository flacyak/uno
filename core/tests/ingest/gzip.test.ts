/**
 * @fileoverview The gzip inflater over the fixtures in testdata/gzip: what it
 * decodes against fflate, where it breaks, its heads, and its checkpoints.
 */

import { Gunzip } from 'fflate';
import { describe, expect, test } from 'vite-plus/test';

import {
  ALONE,
  BrokenStream,
  gunzipWhole,
  gzipInflater,
  inflateHead,
} from '@ingest/gzip';
import type { Checkpoint, Inflater } from '@ingest/gzip';
import { concat, differAt, fixture } from './bytes.ts';

/** The gzip fixtures: one of each shape a file comes in. */
const FIXTURES = [
  'sales-q3.csv.gz',
  'stored.gz',
  'twice.csv.gz',
  'members.csv.gz',
  'bgzf.csv.gz',
  'empty.gz',
];

/** Stored bytes pushed at a time: an odd size, and with it one byte and all. */
const SLICE = 4093;
const SLICES = [1, SLICE, Number.MAX_SAFE_INTEGER];

/** A gzip trailer: the CRC, then the length. */
const CRC_BYTES = 4;
const TRAILER_BYTES = 8;
const NO_BYTES = new Uint8Array(0);
/** A span of one byte keeps every block boundary that decodes anything. */
const EVERY_BOUNDARY = 1;

/** What fflate's streaming gunzip makes of every member. */
function fflate(stored: Uint8Array): Uint8Array {
  const pieces: Uint8Array[] = [];
  new Gunzip((piece) => pieces.push(piece)).push(stored, true);
  return concat(pieces);
}

/** One pass of `inflater`, `slice` stored bytes at a push. */
function pass(
  stored: Uint8Array,
  slice: number,
  inflater: Inflater = gzipInflater(ALONE),
): { decoded: Uint8Array; checkpoints: readonly Checkpoint[] } {
  const pieces: Uint8Array[] = [];
  const offsets: number[] = [];
  for (let at = 0; at < stored.length; at += slice) {
    inflater.push(stored.subarray(at, at + slice), (piece, offset) => {
      pieces.push(piece.slice());
      offsets.push(offset);
    });
  }
  const decoded = concat(pieces);
  let length = 0;
  const misplaced = pieces.findIndex((piece, i) => {
    const wrong = offsets[i] !== length;
    length += piece.length;
    return wrong;
  });
  expect(misplaced, 'the first piece out of place').toBe(-1);
  expect(inflater.end()).toBe(decoded.length);
  return { decoded, checkpoints: inflater.checkpoints() };
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
    for (const slice of SLICES) {
      expect(differAt(pass(stored, slice).decoded, want)).toBe(-1);
    }
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
    const inflater = gzipInflater(ALONE);
    inflater.push(stored.subarray(0, cut), () => {});
    expect(brokenAt(() => inflater.end())).toBe(cut);
    expect(brokenAt(() => gunzipWhole(stored.subarray(0, cut)))).toBe(cut);
  });

  test('with a damaged CRC in its last member, just past the CRC', () => {
    const crcAt = stored.length - TRAILER_BYTES;
    const damaged = stored.slice();
    damaged[crcAt]! ^= 1;
    const inflater = gzipInflater(ALONE);
    expect(brokenAt(() => inflater.push(damaged, () => {}))).toBe(
      crcAt + CRC_BYTES,
    );
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

/** Where each BGZF block's deflate data starts, and its decoded offset. */
function bgzfBlocks(stored: Uint8Array): Omit<Checkpoint, 'window' | 'bits'>[] {
  const BLOCK_SIZE_AT = 16;
  const HEADER_BYTES = 18;
  const LENGTH_BYTES = 4;
  const view = new DataView(stored.buffer, stored.byteOffset);
  const blocks: Omit<Checkpoint, 'window' | 'bits'>[] = [];
  let decoded = 0;
  for (let at = 0; at < stored.length;) {
    blocks.push({ stored: at + HEADER_BYTES, decoded });
    // BSIZE, the block's size less one.
    at += view.getUint16(at + BLOCK_SIZE_AT, true) + 1;
    decoded += view.getUint32(at - LENGTH_BYTES, true);
  }
  return blocks;
}

describe('a gzip pass keeps checkpoints', () => {
  /** The member starts a pass that keeps every block boundary keeps. */
  function memberStarts(stored: Uint8Array): Checkpoint[] {
    const inflater = gzipInflater(ALONE, EVERY_BOUNDARY);
    const { checkpoints } = pass(stored, SLICE, inflater);
    return checkpoints.filter(({ window }) => window.length === 0);
  }

  test('at member starts, with no window', () => {
    const bgzf = fixture('gzip/bgzf.csv.gz');
    expect(memberStarts(bgzf)).toEqual(
      bgzfBlocks(bgzf).map((at) => ({ ...at, bits: 0, window: NO_BYTES })),
    );
    const parts = [1, 2].map((n) => fixture(`sales-q3-part-${n}.csv`).length);
    const members = memberStarts(fixture('gzip/members.csv.gz'));
    expect(members.map((point) => point.decoded)).toEqual([
      0,
      parts[0],
      parts[0]! + parts[1]!,
    ]);
  });

  test('a span apart, member starts as well', () => {
    const { checkpoints } = pass(fixture('gzip/bgzf.csv.gz'), SLICE);
    expect(checkpoints.map(({ decoded }) => decoded)).toEqual([0]);
  });
});
