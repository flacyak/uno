/**
 * @fileoverview A Reading is how the engine reads one source's rows: an index
 * of where its blocks are, the blocks read through it, the pass that fills
 * the index, and what holds the stored bytes a save records.
 *
 * The View holds one Reading and asks it alone how its rows are read.
 */

import type { Column, HeaderMode } from '@ingest';
import type { Said } from '@said';
import type { ByteSource, MultiSource } from '@store';

/** Indexed is how much of a source's stored bytes its pass has accounted for. */
export interface Indexed {
  /** Stored bytes accounted for so far. */
  readonly done: number;
  /** Stored bytes in all. */
  readonly total: number;
}

/** Index says where each block of a source's rows is, as far as its pass has got. */
export interface Index {
  /** Whether the pass has reached the end. */
  readonly complete: boolean;
  /** How many rows can be read now. */
  readable(): number;
  /** The row count once complete, or an estimate until then. */
  rows(): number;
  /** The block holding a readable row. */
  blockOf(row: number): number;
  /** A block's rows, as [first, end). */
  rowsOf(block: number): readonly [number, number];
  /** How far the pass has got, which a Progress reports. */
  indexed(): Indexed;
}

/** Blocks reads a source's rows a block at a time, through its Index. */
export interface Blocks {
  /** Up to `count` rows from `first`, stopping at the readable limit. */
  rows(first: number, count: number): Promise<string[][]>;
  /** One block's rows. With `keep = false` any cache is left as it is. */
  records(block: number, keep?: boolean): Promise<string[][]>;
}

/** Run is a run of a block's rows that came from one part. */
export interface Run {
  /** The first row of the run, counting from 0 at the block's first. */
  readonly row: number;
  /** Which part, counting from 0. */
  readonly part: number;
}

/** ReadSpec is how a source's rows were read, which a save records. */
export type ReadSpec = {
  readonly kind: 'delimited';
  /** Whether the first record names the columns. */
  readonly header: HeaderMode;
};

/** Behind is what holds a source's stored bytes: one file, or several joined as bytes. */
export type Behind =
  | { readonly t: 'file'; readonly stored: ByteSource }
  | { readonly t: 'bytes'; readonly joined: MultiSource };

/** Reading is one source's rows: how they are found, read and saved. */
export interface Reading {
  /** How the source was read, for the status bar. */
  readonly label: Said;
  readonly index: Index;
  readonly pages: Blocks;
  readonly behind: Behind;
  /** The data columns, in the order their cells come in a row. */
  columns(): readonly Column[];
  /** How the source was read, as a save records it now. */
  spec(): ReadSpec;
  /**
   * pass fills the index, calling `progress` after each step. It returns
   * early once `signal` aborts.
   */
  pass(signal: AbortSignal, progress: () => void): Promise<void>;
  /** Which part each row of a block came from. One run for one file. */
  runs(block: number): Promise<readonly Run[]>;
  /** Closes the stored bytes. */
  close(): Promise<void>;
}
