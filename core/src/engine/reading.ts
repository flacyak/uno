/**
 * @fileoverview A Reading is how the engine reads one source's rows: an index
 * of where its blocks are, the blocks read through it, the pass that fills
 * the index, and what holds the stored bytes a save records.
 *
 * The View holds one Reading and asks it alone how its rows are read.
 */

import type { Column, HeaderMode, RecordFormat } from '@ingest';
import { Refusal } from '@said';
import type { Said } from '@said';
import type { ByteSource, MultiSource } from '@store';
import type { RowIndex } from './rows.ts';

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

/** Crossing is the runs of a block, found over the byte range it had then. */
interface Crossing {
  readonly start: number;
  readonly end: number;
  readonly runs: readonly Run[];
}

/**
 * partRuns returns which part each row of a block came from, for parts
 * joined as bytes.
 *
 * A block inside one part is one run. A block that crosses a part boundary
 * is re-read up to its last part and scanned for row starts, and the result
 * is cached for the byte range it was found over.
 */
export function partRuns(
  name: string,
  joined: MultiSource,
  records: Pick<RecordFormat, 'scanner'>,
  index: Pick<RowIndex, 'bytesOf'>,
): (block: number) => Promise<readonly Run[]> {
  const { map } = joined;
  const crossings = new Map<number, Crossing>();
  return async (block) => {
    const [start, end] = index.bytesOf(block);
    const first = map.partAt(start);
    const last = map.partAt(end - 1);
    if (first === undefined || last === undefined) {
      throw new Refusal({ t: 'rows-past-files', name });
    }
    if (first === last) return [{ row: 0, part: first }];

    const known = crossings.get(block);
    if (known !== undefined && known.start === start && known.end === end) {
      return known.runs;
    }

    // Rows from the last part's first byte on belong to it, so only the
    // bytes before it are scanned.
    const until = map.spans[last]!.start;
    const runs: Run[] = [];
    let row = 0;
    const scanner = records.scanner((offset) => {
      const part = map.partAt(offset)!;
      if (runs.at(-1)?.part !== part) runs.push({ row, part });
      row++;
    });
    scanner.push(await joined.read(start, until - start), start);
    runs.push({ row, part: last });

    crossings.set(block, { start, end, runs });
    return runs;
  };
}
