/**
 * @fileoverview Reads back from a gzip inflater, over a file that holds every
 * kind of checkpoint a read resumes from.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { describe, expect, test } from 'vite-plus/test';

import { ALONE, INFLATE_SLICE_BYTES, gzipInflater } from '@ingest/gzip';
import type { Inflater, InflaterBudget } from '@ingest/gzip';
import { bytesSource } from '@store';
import { concat, fixture, kind } from './bytes.ts';

/** Rows of text on each side of the noise. */
const ROWS = 480_000;
/** Names a row picks from, so the text compresses as text does. */
const NAMES = 997;
/** Cents in a unit, for a row's amount. */
const CENTS = 100;
/** Noise between the rows, which deflate keeps in stored blocks. */
const NOISE_BYTES = 2 << 20;
/** A span the file passes many times over, so it holds many checkpoints. */
const SPAN = 256 << 10;

/** Bytes that look random, the same on every run for a seed. */
function noise(seed: string, length: number): Uint8Array {
  const hash = createHash('shake256', { outputLength: length });
  return new Uint8Array(hash.update(seed).digest());
}

/** Rows of text numbered from `first`, no two alike. */
function rows(first: number, count: number): Uint8Array {
  const lines: string[] = [];
  for (let n = first; n < first + count; n++) {
    lines.push(`${n},name ${n % NAMES},${(n / CENTS).toFixed(2)}\n`);
  }
  return new TextEncoder().encode(lines.join(''));
}

/**
 * About 24 MB of rows around noise, as one member, then the members and BGZF
 * fixtures. The noise is in stored blocks, and the rows' blocks start part
 * way into a byte.
 */
const stored = concat([
  gzipSync(
    concat([rows(0, ROWS), noise('noise', NOISE_BYTES), rows(ROWS, ROWS)]),
  ),
  fixture('gzip/members.csv.gz'),
  fixture('gzip/bgzf.csv.gz'),
]);

/** An inflater that has passed the whole file. */
function passed(budget: InflaterBudget): Inflater {
  const inflater = gzipInflater(bytesSource(stored), budget, SPAN);
  for (let at = 0; at < stored.length; at += INFLATE_SLICE_BYTES) {
    inflater.push(stored.subarray(at, at + INFLATE_SLICE_BYTES), () => {});
  }
  inflater.end();
  return inflater;
}

describe('a gzip read', () => {
  test('resumes from checkpoints of every kind, past the first', () => {
    const [, ...points] = passed(ALONE).checkpoints();
    expect(new Set(points.map(kind))).toEqual(
      new Set(['a member start', 'a byte', 'even bits', 'odd bits']),
    );
  });
});
