/**
 * @fileoverview A Parquet file as the engine reads it. Its footer says how
 * many rows it has, so every block is planned when it opens: a block is
 * blockRows of its rows, and the index is complete from the start.
 *
 * A block of row groups with offset indexes reads alone, from the pages
 * that hold it. Without them hyparquet walks a row group's pages from its
 * start, and one page holds the rows of many blocks, so a block decodes with
 * the blocks around it, a window at a time, and every block of the window is
 * kept. A window holds as many blocks as DECODE_WINDOW_BYTES allows, counted
 * at the heaviest of its row groups' uncompressed bytes.
 */

import type { Table } from '@ingest';
import { Refusal } from '@said';
import type { Blocks, Index, Indexed } from './reading.ts';
import { BlockCache, rowsThrough } from './rows.ts';

/**
 * The uncompressed row group bytes one window decodes at most, which bounds
 * both the memory and the time a decode takes.
 */
export const DECODE_WINDOW_BYTES = 16 << 20;

/** The most blocks one window decodes, however small its rows. */
export const MAX_WINDOW_BLOCKS = 16;

/**
 * What a cell costs the cache on top of its text: the byte that ends it as
 * delimited text, a delimiter or a newline.
 */
const CELL_END_BYTES = 1;

/**
 * PlannedIndex is an Index whose blocks are all known when it is made: each
 * is `blockRows` rows of a source of `count` rows, the last maybe fewer.
 */
export class PlannedIndex implements Index {
  readonly complete = true;
  private readonly count: number;
  /** The stored bytes, which the footer accounts for whole. */
  private readonly size: number;
  readonly blockRows: number;

  constructor(count: number, size: number, blockRows: number) {
    this.count = count;
    this.size = size;
    this.blockRows = blockRows;
  }

  /** How many blocks the rows make. */
  get blocks(): number {
    return Math.ceil(this.count / this.blockRows);
  }

  readable(): number {
    return this.count;
  }

  rows(): number {
    return this.count;
  }

  blockOf(row: number): number {
    return Math.floor(row / this.blockRows);
  }

  rowsOf(block: number): readonly [number, number] {
    const first = block * this.blockRows;
    return [first, Math.min(first + this.blockRows, this.count)];
  }

  indexed(): Indexed {
    return { done: this.size, total: this.size };
  }
}

/** TableRows is what TablePages reads of a Table. */
export type TableRows = Pick<Table, 'read' | 'paged' | 'bytesPerRow'>;

/** Window is blocks decoded together: the first one's number, and each one's rows. */
interface Window {
  readonly first: number;
  readonly blocks: readonly string[][][];
}

/**
 * TablePages reads a table's blocks through a BlockCache. A block costs the
 * cache the bytes its rows would take as delimited text, so its budget means
 * about as many rows as for a text file.
 */
export class TablePages implements Blocks {
  /** What a refusal names. */
  private readonly name: string;
  private readonly table: TableRows;
  private readonly index: PlannedIndex;
  private readonly cache: BlockCache;
  /** Windows being read to keep, by each block they hold. */
  private readonly loading = new Map<number, Promise<Window>>();
  /**
   * The last window read to keep nothing, so a scan down the rows decodes
   * each window once and leaves the cache as it is.
   */
  private passing: Window | undefined;

  constructor(
    name: string,
    table: TableRows,
    index: PlannedIndex,
    budget: number,
  ) {
    this.name = name;
    this.table = table;
    this.index = index;
    this.cache = new BlockCache(budget);
  }

  /** The text bytes of the blocks in the cache. */
  get held(): number {
    return this.cache.held;
  }

  rows(first: number, count: number): Promise<string[][]> {
    return rowsThrough(
      this.index,
      (block) => this.records(block),
      first,
      count,
    );
  }

  /**
   * records reads one block's rows, with the blocks of its window. With
   * `keep = false` they are decoded and the cache is left as it is, and the
   * window is held aside for the next block until another replaces it.
   */
  async records(block: number, keep = true): Promise<string[][]> {
    const hit = this.cache.get(block) ?? blockIn(this.passing, block);
    if (hit !== undefined) return hit;
    const window = await (this.loading.get(block) ?? this.load(block, keep));
    return window.blocks[block - window.first]!;
  }

  /** load decodes the window holding `block`, and with `keep` caches it. */
  private load(block: number, keep: boolean): Promise<Window> {
    const [first, end] = this.windowOf(block);
    if (!keep) {
      return this.decode(first, end).then((window) => (this.passing = window));
    }
    const pending = this.decode(first, end)
      .then((window) => {
        window.blocks.forEach((rows, i) => {
          this.cache.put(first + i, rows, textBytes(rows));
        });
        return window;
      })
      .finally(() => {
        for (let b = first; b < end; b++) this.loading.delete(b);
      });
    for (let b = first; b < end; b++) this.loading.set(b, pending);
    return pending;
  }

  /**
   * windowOf returns the blocks [first, end) read with `block`: it alone
   * where its row groups are paged, and otherwise the aligned window of as
   * many as fit in DECODE_WINDOW_BYTES, up to MAX_WINDOW_BLOCKS.
   */
  private windowOf(block: number): [number, number] {
    const [start, end] = this.index.rowsOf(block);
    if (this.table.paged(start, end)) return [block, block + 1];
    // A smaller window can leave out a heavier row group, so each size is
    // measured over the rows it covers until they fit.
    for (let size = MAX_WINDOW_BLOCKS; ;) {
      const first = block - (block % size);
      const window: [number, number] = [
        first,
        Math.min(first + size, this.index.blocks),
      ];
      const fits = this.fitting(window);
      if (fits >= size) return window;
      size = fits;
    }
  }

  /**
   * How many blocks of the rows of blocks [first, end) fit in
   * DECODE_WINDOW_BYTES, at least one. A row counts as the most
   * uncompressed bytes per row of the row groups under them.
   */
  private fitting([first, end]: readonly [number, number]): number {
    const [start] = this.index.rowsOf(first);
    const [, stop] = this.index.rowsOf(end - 1);
    const perRow = this.table.bytesPerRow(start, stop);
    const blockBytes = perRow * this.index.blockRows;
    return Math.max(1, Math.floor(DECODE_WINDOW_BYTES / blockBytes));
  }

  /** decode reads blocks [first, end) in one read of the table. */
  private async decode(first: number, end: number): Promise<Window> {
    const [start] = this.index.rowsOf(first);
    const [, stop] = this.index.rowsOf(end - 1);
    const rows = await this.table.read(start, stop);
    // The footer said how many rows there are, and the pages hold others.
    if (rows.length !== stop - start) {
      throw new Refusal({ t: 'parquet-broken', name: this.name });
    }
    const blocks: string[][][] = [];
    for (let b = first; b < end; b++) {
      const [from, to] = this.index.rowsOf(b);
      blocks.push(rows.slice(from - start, to - start));
    }
    return { first, blocks };
  }
}

/** blockIn returns `block`'s rows where `window` holds them. */
function blockIn(
  window: Window | undefined,
  block: number,
): string[][] | undefined {
  return window === undefined ? undefined : window.blocks[block - window.first];
}

/**
 * textBytes is about the bytes `rows` would take as delimited text: the
 * length of each cell, and one more for what ends it.
 */
function textBytes(rows: readonly string[][]): number {
  let bytes = 0;
  for (const row of rows) {
    for (const cell of row) bytes += cell.length + CELL_END_BYTES;
  }
  return bytes;
}
