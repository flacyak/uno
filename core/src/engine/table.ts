/**
 * @fileoverview A Parquet file as the engine reads it. Its footer says how
 * many rows it has, so every block is planned when it opens: a block is
 * blockRows of its rows, and the index is complete from the start.
 */

import type { Table } from '@ingest';
import { Refusal } from '@said';
import type { Blocks, Index, Indexed } from './reading.ts';
import { rowsThrough } from './rows.ts';

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

/** TablePages reads a table's rows a block at a time. */
export class TablePages implements Blocks {
  /** What a refusal names. */
  private readonly name: string;
  private readonly table: TableRows;
  private readonly index: PlannedIndex;

  constructor(name: string, table: TableRows, index: PlannedIndex) {
    this.name = name;
    this.table = table;
    this.index = index;
  }

  rows(first: number, count: number): Promise<string[][]> {
    return rowsThrough(
      this.index,
      (block) => this.records(block),
      first,
      count,
    );
  }

  /** records reads one block's rows from the table. */
  async records(block: number): Promise<string[][]> {
    const [start, end] = this.index.rowsOf(block);
    const rows = await this.table.read(start, end);
    // The footer said how many rows there are, and the pages hold others.
    if (rows.length !== end - start) {
      throw new Refusal({ t: 'parquet-broken', name: this.name });
    }
    return rows;
  }
}
