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
 * at the heaviest of its row groups' uncompressed bytes and of the text the
 * last window took per row.
 */

import type { KeyedColumn, Table } from '@ingest';
import { Refusal } from '@said';
import { namesBeside } from '@sheet';
import type { ByteSource } from '@store';
import type { Blocks, Index, Indexed, Reading } from './reading.ts';
import { BlockCache, ONE_FILE, rowsThrough } from './rows.ts';
import type { Tuning } from './rows.ts';

/**
 * The bytes one window's rows take at most, uncompressed or as text, which
 * bounds both the memory and the time a decode takes.
 */
export const DECODE_WINDOW_BYTES = 16 << 20;

/** The most blocks one window decodes, however small its rows. */
export const MAX_WINDOW_BLOCKS = 16;

/**
 * What a cell costs the cache on top of its text: the byte that ends it as
 * delimited text, a delimiter or a newline.
 */
const CELL_END_BYTES = 1;

/** Where a pinned column the file no longer has finds its cells: nowhere. */
const ABSENT = -1;

/**
 * tableReading reads a Parquet file through its Table, whose footer was
 * read as it opened. Its columns are those `pinned` in their order, each
 * found by its key, then the file's others in its order, so a reordered
 * schema leaves every logged edit on its cell. A pinned key the file no
 * longer has is a column of empty cells. Its index is complete from the
 * start, so its pass only says so.
 */
export function tableReading(
  name: string,
  file: ByteSource,
  table: Table,
  tuning: Tuning,
  pinned: readonly KeyedColumn[],
): Reading {
  const index = new PlannedIndex(table.rows, file.size, tuning.blockRows);
  const columns = laidOut(pinned, table.columns);
  const at = new Map(table.columns.map(({ key }, i) => [key, i]));
  const from = columns.map(({ key }) => at.get(key) ?? ABSENT);
  const read = async (start: number, end: number): Promise<string[][]> => {
    const rows = await table.read(start, end);
    return rows.map((row) => from.map((i) => (i === ABSENT ? '' : row[i]!)));
  };
  const rows: TableRows = {
    read,
    paged: table.paged.bind(table),
    bytesPerRow: table.bytesPerRow.bind(table),
  };
  const { codecs, groups } = table;
  return {
    label: { t: 'read-parquet', codecs: [...codecs], groups },
    index,
    pages: new TablePages(name, rows, index, tuning.cacheBytes),
    behind: { t: 'file', stored: file },
    columns: () => columns,
    spec: () => ({ kind: 'parquet', columns }),
    pass: (signal, progress) => {
      if (!signal.aborted) progress();
      return Promise.resolve();
    },
    runs: () => Promise.resolve(ONE_FILE),
    close: () => file.close(),
  };
}

/**
 * laidOut returns `pinned`, then each of `found` that none of them has the
 * key of, named beside them by the column suffix rule.
 */
function laidOut(
  pinned: readonly KeyedColumn[],
  found: readonly KeyedColumn[],
): KeyedColumn[] {
  const keys = new Set(pinned.map(({ key }) => key));
  const added = found.filter(({ key }) => !keys.has(key));
  const names = namesBeside(
    pinned.map(({ name }) => name),
    added.map(({ name }) => name),
  );
  return [...pinned, ...added.map(({ key }, i) => ({ name: names[i]!, key }))];
}

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

/** Window is blocks decoded together. */
interface Window {
  /** The first block's number. */
  readonly first: number;
  /** Each block's rows. */
  readonly blocks: readonly string[][][];
  /** Each block's bytes as delimited text. */
  readonly costs: readonly number[];
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
   * The window decoded last, whether it was kept or not. Its blocks are
   * read from it until another replaces it, so a scan that keeps nothing
   * decodes each window once, and a block the cache let go to hold the rest
   * of its own window is not decoded again.
   */
  private last: Window | undefined;
  /** The text bytes per row of the window decoded last. */
  private textPerRow = 0;

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
   * `keep = false` they are decoded and the cache is left as it is.
   */
  async records(block: number, keep = true): Promise<string[][]> {
    const hit = this.cache.get(block) ?? blockIn(this.last, block);
    if (hit !== undefined) return hit;
    const window = await (this.loading.get(block) ?? this.load(block, keep));
    return window.blocks[block - window.first]!;
  }

  /** load decodes the window holding `block`, and with `keep` caches it. */
  private load(block: number, keep: boolean): Promise<Window> {
    const [first, end] = this.windowOf(block);
    const decoded = this.decode(first, end);
    if (!keep) return decoded;
    const pending = decoded
      .then((window) => {
        window.blocks.forEach((rows, i) => {
          this.cache.put(first + i, rows, window.costs[i]!);
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
   * uncompressed bytes per row of the row groups under them, or as the
   * text bytes per row of the last window where that is more.
   */
  private fitting([first, end]: readonly [number, number]): number {
    const [start] = this.index.rowsOf(first);
    const [, stop] = this.index.rowsOf(end - 1);
    const perRow = Math.max(
      this.table.bytesPerRow(start, stop),
      this.textPerRow,
    );
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
    const costs = blocks.map(textBytes);
    const text = costs.reduce((sum, cost) => sum + cost, 0);
    if (rows.length > 0) this.textPerRow = text / rows.length;
    this.last = { first, blocks, costs };
    return this.last;
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
