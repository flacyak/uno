/**
 * @fileoverview Measures a second save of the same carried bytes, and of the
 * same row index. The second save must reuse the first's deflated bytes, so
 * it must be much cheaper than the first.
 */

import { expect, test } from 'vite-plus/test';

import { newManifest, readContainer, writeDocument } from '@document';
import type { Document, HeldFile, SavedSource } from '@document';
import { bytes } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
import type { Metric } from './record.ts';

/** 24 MB. */
const REPEATS = 100;

/** How many times cheaper than the first the second save must be. */
const CHEAPER = 2;

function carried(repeats: number): Uint8Array {
  const raw = new Uint8Array(bytes.length * repeats);
  for (let i = 0; i < repeats; i++) raw.set(bytes, i * bytes.length);
  return raw;
}

function workspace(raw: Uint8Array): Document {
  return {
    manifest: newManifest(),
    sources: [
      {
        id: 'sales',
        name: 'sales.csv',
        raw,
        bytes: raw.length,
        rows: 0,
        cols: 0,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: 'sales',
    log: [],
    extra: new Map(),
    at: '',
  };
}

/** Whether two arrays hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function timed(fn: () => Uint8Array): { out: Uint8Array; ms: number } {
  const began = performance.now();
  const out = fn();
  return { out, ms: performance.now() - began };
}

const metrics: Metric[] = [];

test('a save of bytes already saved does not deflate them again', () => {
  const raw = carried(REPEATS);
  const doc = workspace(raw);
  const first = timed(() => writeDocument(doc));
  // The same bytes in a new array, as a Blob read again would give.
  doc.sources[0]!.raw = new Uint8Array(raw);
  const again = timed(() => writeDocument(doc));

  metrics.push(
    { name: 'save of 24 MB carried: first, ms', unit: 'ms', value: first.ms },
    { name: 'save of 24 MB carried: again, ms', unit: 'ms', value: again.ms },
  );
  record('save', metrics);
  expect(again.ms).toBeLessThan(first.ms / CHEAPER);

  const back = readContainer('test.uno', again.out);
  expect(
    same(back.sources[0]!.raw!, raw),
    'the source went in byte for byte',
  ).toBe(true);
  expect(back.manifest.sources[0]!.sha256).toBe(
    readContainer('test.uno', first.out).manifest.sources[0]!.sha256,
  );
}, 60_000);

/** 15 MiB of block starts, under a source's cap: about 3 billion rows. */
const BLOCKS_BYTES = 15 << 20;
/** Where the indexed file is. */
const POINTED = '/data/orders.csv';

/** A cache of `blocks`, as a save keeps one. */
function cached(blocks: Uint8Array): SavedSource {
  return {
    path: POINTED,
    key: { bytes: 1 },
    counted: 1,
    complete: true,
    blocks,
  };
}

test('a save of a row index already saved does not deflate its blocks again', () => {
  const doc = workspace(carried(1));
  const { raw: _, ...pointed } = doc.sources[0] as HeldFile;
  doc.sources = [{ ...pointed, path: POINTED }];
  // Varied bytes, so they deflate about as a real index's block starts do.
  const blocks = Uint8Array.from(
    { length: BLOCKS_BYTES },
    (_, i) => (i * 2_654_435_761) >>> 24,
  );
  doc.cache = new Map([['sales', cached(blocks)]]);
  const first = timed(() => writeDocument(doc));
  // The same starts encoded again, as a save does once a block begins.
  doc.cache = new Map([['sales', cached(new Uint8Array(blocks))]]);
  const again = timed(() => writeDocument(doc));

  metrics.push(
    {
      name: 'save of 15 MiB of block starts: first, ms',
      unit: 'ms',
      value: first.ms,
    },
    {
      name: 'save of 15 MiB of block starts: again, ms',
      unit: 'ms',
      value: again.ms,
    },
  );
  record('save', metrics);
  expect(again.ms).toBeLessThan(first.ms / CHEAPER);
  const back = readContainer('test.uno', again.out).cache?.get('sales');
  expect(same(back!.blocks, blocks), 'the starts went in byte for byte').toBe(
    true,
  );
}, 60_000);
