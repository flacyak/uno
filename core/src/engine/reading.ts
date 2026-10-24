/**
 * @fileoverview A Reading is how the engine reads one source's rows: an index
 * of where its blocks are, the blocks read through it, the pass that fills
 * the index, and what holds the stored bytes a save records.
 *
 * The View holds one Reading and asks it alone how its rows are read.
 */

import type { Held, SavedColumn } from '@document';
import {
  CHUNK_CACHE_BYTES,
  chunkCache,
  delimitedRecords,
  detect,
  headOf,
  kindOf,
  linesFormat,
  openFormat,
  pointerTo,
  openTable,
  refuseNotRead,
} from '@ingest';
import type { Column, HeaderMode, KeyedColumn, RecordFormat } from '@ingest';
import { unreachable } from '@never';
import { Refusal } from '@said';
import type { ReadKind, Said } from '@said';
import { headed, multiOf } from '@store';
import type { ByteSource, MultiSource } from '@store';
import { indexPass } from './pass.ts';
import { ONE_FILE, Pages, RowIndex } from './rows.ts';
import type { Tuning } from './rows.ts';
import { tableReading } from './table.ts';

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
export type ReadSpec =
  | {
      readonly kind: 'delimited';
      /** Whether the first record names the columns. */
      readonly header: HeaderMode;
    }
  | {
      readonly kind: 'jsonl';
      /** The columns in order, each found by its key wherever it is first seen. */
      readonly columns: readonly KeyedColumn[];
    }
  | {
      readonly kind: 'parquet';
      /** The columns in order, each found by its key in the file's schema. */
      readonly columns: readonly KeyedColumn[];
    };

/**
 * readOf returns how a .uno source's rows were read when its log was made. A
 * source that names no kind is delimited text, in every format, so no log
 * moves under a detector that would read its file another way. JSON Lines
 * starts from the columns it pinned, so each key finds its column again.
 */
export function readOf(
  src: Pick<Held, 'kind' | 'header' | 'columns'>,
): ReadSpec {
  switch (src.kind) {
    case undefined:
      return { kind: 'delimited', header: src.header ?? 'first' };
    case 'jsonl':
      return { kind: 'jsonl', columns: (src.columns ?? []).map(keyedOf) };
    default:
      return unreachable(src.kind);
  }
}

/**
 * keyedOf returns a pinned column with its key, which a save leaves out
 * where it is the pointer to a top-level field called the column's name.
 */
function keyedOf({ name, key }: SavedColumn): KeyedColumn {
  return { name, key: key ?? pointerTo('', name) };
}

/**
 * savedOf returns what a save writes of how a source's rows were read,
 * which readOf reads back. Delimited text writes nothing, as it always has.
 * JSON Lines writes its kind and every column in the spec, so a reopen
 * gives each key its column before the pass reaches it.
 */
export function savedOf(spec: ReadSpec): Pick<Held, 'kind' | 'columns'> {
  switch (spec.kind) {
    case 'delimited':
      return {};
    case 'jsonl':
      return { kind: 'jsonl', columns: spec.columns.map(pinnedOf) };
    case 'parquet':
      // Written once a .uno can say a source is Parquet.
      return {};
    default:
      return unreachable(spec);
  }
}

/**
 * pinnedOf returns a column as a save pins it, leaving out a key keyedOf
 * finds again from the name.
 */
function pinnedOf({ name, key }: KeyedColumn): SavedColumn {
  return key === pointerTo('', name) ? { name } : { name, key };
}

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

/** Expected is what a relinked file is held to. */
export interface Expected {
  /** The source's name, which a refusal names beside the file's. */
  readonly name: string;
  /** The kind of rows the source's log was read as. */
  readonly kind: ReadKind;
}

/** ReadAsk is what openReading is given. */
export interface ReadAsk {
  /** The file's name, which detection reads and errors name. */
  readonly name: string;
  /** The stored bytes: one file, or several joined as bytes. */
  readonly source: ByteSource;
  /** How a log was read. Detection is skipped, and the bytes are read so. */
  readonly spec?: ReadSpec;
  /** What a relink holds the file to. One detected as another kind of rows
   * is refused as one. */
  readonly expect?: Expected;
  /** Whether the first record names the columns, where no spec says. */
  readonly header: HeaderMode;
  readonly tuning: Tuning;
}

/**
 * openReading reads the head of a source and opens its Reading. A source
 * with no spec is detected first, its head read once. One held to JSON Lines
 * starts from the columns its spec pins, and learns the rest as it is
 * indexed. One held to Parquet reads its footer, through a cache of the
 * chunks it reads that the View keeps.
 */
export async function openReading(ask: ReadAsk): Promise<Reading> {
  const { name, source, spec, tuning } = ask;
  if (spec?.kind === 'jsonl') {
    const lines = linesFormat(name, (await headOf(source)).bytes, spec.columns);
    return recordReading(name, source, lines, tuning, () => ({
      kind: 'jsonl',
      columns: lines.columns(),
    }));
  }
  if (spec?.kind === 'parquet') {
    const table = await openTable(name, source, chunkCache(CHUNK_CACHE_BYTES));
    return tableReading(name, source, table, tuning);
  }
  const head = spec === undefined ? await detectedHead(ask) : undefined;
  const format = await openFormat(
    name,
    head === undefined ? source : headed(source, head),
    spec?.header ?? ask.header,
  );
  const delimited: ReadSpec = { kind: 'delimited', header: format.header };
  return recordReading(
    name,
    source,
    delimitedRecords(format),
    tuning,
    () => delimited,
  );
}

/**
 * detectedHead reads a source's head and detects what it holds. A file of
 * another kind of rows than a relink expects is refused as one, ahead of a
 * file this build does not read, which is refused by name.
 */
async function detectedHead(ask: ReadAsk): Promise<Uint8Array> {
  const { name, expect } = ask;
  const head = await headOf(ask.source);
  const found = await detect(name, head);
  const now = kindOf(found);
  if (expect !== undefined && now !== undefined && now !== expect.kind) {
    throw new Refusal({
      t: 'relink-other-kind',
      name: expect.name,
      file: name,
      was: expect.kind,
      now,
    });
  }
  refuseNotRead(name, found);
  return head.bytes;
}

/**
 * recordReading reads a file of records: the index pass finds where each
 * block of them starts, and Pages decode a block at a time. `spec` says how
 * they are read as of when it is called.
 */
function recordReading(
  name: string,
  source: ByteSource,
  records: RecordFormat,
  tuning: Tuning,
  spec: () => ReadSpec,
): Reading {
  const index = new RowIndex(records.dataStart, source.size, tuning);
  const joined = multiOf(source);
  const format = {
    dataStart: records.dataStart,
    scanner: (begin: (offset: number) => void) => records.indexer(begin),
  };
  return {
    label: records.label(),
    index,
    pages: new Pages(name, source, records, index, tuning.cacheBytes),
    behind:
      joined === undefined
        ? { t: 'file', stored: source }
        : { t: 'bytes', joined },
    columns: () => records.columns(),
    spec,
    pass: (signal, progress) =>
      indexPass({ source, format, index, tuning, signal, progress }),
    runs:
      joined === undefined
        ? () => Promise.resolve(ONE_FILE)
        : partRuns(name, joined, records, index),
    close: () => source.close(),
  };
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
function partRuns(
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
