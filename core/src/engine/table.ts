/**
 * @fileoverview A Parquet file as the engine reads it. Its footer says how
 * many rows it has, so every block is planned when it opens: a block is
 * blockRows of its rows, and the index is complete from the start.
 */

import type { Table } from '@ingest';
import { Refusal } from '@said';
import type { Blocks, Index, Indexed } from './reading.ts';
import { BlockCache, rowsThrough } from './rows.ts';

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
export type TableRows = Pick<Table, 'read'>;

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
   * records reads one block's rows. With `keep = false` they are read and
   * the cache is left as it is.
   */
  async records(block: number, keep = true): Promise<string[][]> {
    const hit = this.cache.get(block);
    if (hit !== undefined) return hit;
    const rows = await this.decode(block);
    if (keep) this.cache.put(block, rows, textBytes(rows));
    return rows;
  }

  /** decode reads one block's rows from the table. */
  private async decode(block: number): Promise<string[][]> {
    const [start, end] = this.index.rowsOf(block);
    const rows = await this.table.read(start, end);
    // The footer said how many rows there are, and the pages hold others.
    if (rows.length !== end - start) {
      throw new Refusal({ t: 'parquet-broken', name: this.name });
    }
    return rows;
  }
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
