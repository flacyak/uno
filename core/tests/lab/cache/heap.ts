/**
 * @fileoverview What a decoded block costs: heap bytes per source byte held in
 * the engine's page cache, and how fast Format.decode turns bytes into rows.
 *
 * cacheBytes budgets the source bytes of the blocks the cache holds, while
 * the cache holds each block as decoded string[][]. The ratio between the two
 * is what a person's memory setting really buys.
 */

import { Pages } from '@engine';
import type { ByteSource } from '@store';
import { blocksOf, heapUsed, layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import { memorySource } from './shapes.ts';

/** HeapReading is one fill of a page cache and the heap it took. */
export interface HeapReading {
  /** Source bytes of the blocks held. */
  heldBytes: number;
  /** Heap bytes the held blocks took, after a full collection. */
  heapBytes: number;
  /** heapBytes over heldBytes. */
  ratio: number;
  /** Heap bytes per source byte of the same blocks as decoded text alone. */
  textRatio: number;
  rows: number;
  fields: number;
}

/**
 * heapPerSourceByte fills a page cache over `bytes` with whole blocks until
 * it holds `fill` source bytes, and returns the heap the blocks took. The
 * same blocks are measured as text alone first.
 */
export async function heapPerSourceByte(
  name: string,
  bytes: Uint8Array,
  fill: number,
  gc: () => void,
): Promise<HeapReading> {
  const source = memorySource(bytes);
  const layout = await layoutOf(name, source);
  const blocks = blocksToFill(layout, fill);
  const text = await textHeap(layout, source, blocks, gc);
  const cache = await cacheHeap(name, layout, source, blocks, gc);
  return {
    ...cache,
    ratio: cache.heapBytes / cache.heldBytes,
    textRatio: text / cache.heldBytes,
  };
}

/** blocksToFill returns how many leading blocks reach `fill` source bytes. */
function blocksToFill(layout: Layout, fill: number): number {
  let blocks = 0;
  while (blocks < layout.blocks && layout.index.bytesOf(blocks)[0] < fill)
    blocks++;
  return blocks;
}

/** cacheHeap holds the first `blocks` blocks in a page cache and weighs them. */
async function cacheHeap(
  name: string,
  layout: Layout,
  source: ByteSource,
  blocks: number,
  gc: () => void,
): Promise<Omit<HeapReading, 'ratio' | 'textRatio'>> {
  // An unbounded budget, so the cache keeps every block it is handed.
  const pages = new Pages(
    name,
    source,
    layout.format,
    layout.index,
    Number.POSITIVE_INFINITY,
  );
  gc();
  const before = heapUsed();
  let rows = 0;
  let fields = 0;
  for (let block = 0; block < blocks; block++) {
    const records = await pages.records(block);
    rows += records.length;
    for (const record of records) fields += record.length;
  }
  gc();
  const heapBytes = heapUsed() - before;
  // Read after the collection, so the cache is live through it.
  return { heldBytes: pages.held, heapBytes, rows, fields };
}

const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** textHeap returns the heap that the first `blocks` blocks take as text alone. */
async function textHeap(
  layout: Layout,
  source: ByteSource,
  blocks: number,
  gc: () => void,
): Promise<number> {
  const texts: string[] = [];
  gc();
  const before = heapUsed();
  for (let b = 0; b < blocks; b++) {
    const [start, end] = layout.index.bytesOf(b);
    texts.push(UTF8.decode(await source.read(start, end - start)));
  }
  gc();
  const used = heapUsed() - before;
  // Read the array after the collection, so it is live through it.
  if (texts.length !== blocks) throw new Error('lost a block of text');
  return used;
}

/** DecodeTimes is one pass of decoding every block of a sample. */
export interface DecodeTimes {
  /** Source bytes decoded. */
  bytes: number;
  /** Milliseconds for Format.decode over every block. */
  decodeMs: number;
  /** Milliseconds for its TextDecoder step alone. The rest is readAll. */
  textMs: number;
}

/**
 * decodeTimes times Format.decode over every block of `bytes`, as the page
 * cache calls it on a miss, `samples` times. Each block's bytes are cut out
 * before the clock starts.
 */
export async function decodeTimes(
  name: string,
  bytes: Uint8Array,
  samples: number,
  gc: () => void,
): Promise<DecodeTimes[]> {
  const layout = await layoutOf(name, memorySource(bytes));
  const chunks: Uint8Array[] = [];
  for (let b = 0; b < layout.blocks; b++) {
    const [start, end] = layout.index.bytesOf(b);
    chunks.push(bytes.subarray(start, end));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const { format } = layout;

  const out: DecodeTimes[] = [];
  for (let s = 0; s < samples; s++) {
    gc();
    let rows = 0;
    let started = performance.now();
    for (const chunk of chunks) rows += format.decode(chunk).length;
    const decodeMs = performance.now() - started;
    if (rows !== layout.index.counted) {
      throw new Error(
        `${name}: decoded ${rows} rows, indexed ${layout.index.counted}`,
      );
    }

    gc();
    let chars = 0;
    started = performance.now();
    for (const chunk of chunks) chars += UTF8.decode(chunk).length;
    const textMs = performance.now() - started;
    if (chars === 0) throw new Error(`${name}: decoded no text`);
    out.push({ bytes: total, decodeMs, textMs });
  }
  return out;
}

/** Blocks a band of `count` rows from `first` spans, and their source bytes. */
export function bandCost(
  layout: Layout,
  first: number,
  count: number,
): { blocks: number; bytes: number } {
  const blocks = blocksOf(layout.index, first, count);
  let bytes = 0;
  for (const b of blocks) {
    const [start, end] = layout.index.bytesOf(b);
    bytes += end - start;
  }
  return { blocks: blocks.length, bytes };
}
