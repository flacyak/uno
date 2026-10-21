/**
 * @fileoverview A Parquet file as a table of text: its footer, read once when
 * it opens, says its columns, its row groups and the codecs of its pages,
 * and its rows are read through hyparquet as the text their writer meant.
 *
 * A file that uses what uno does not read yet is refused by name as
 * parquet-unsupported, and one whose footer does not decode as
 * parquet-broken.
 */

import { parquetMetadata, parquetRead } from 'hyparquet/src/index.js';
import type {
  FileMetaData,
  ParquetParsers,
  RowGroup,
  SchemaElement,
} from 'hyparquet/src/index.js';

import { concat } from '@go';
import { Refusal } from '@said';
import type { ParquetCodec, ParquetFeature } from '@said';
import type { ByteSource } from '@store';

import {
  PARQUET_FOOTER_LENGTH_BYTES,
  PARQUET_MAGIC_BYTES,
  PARQUET_MIN_BYTES,
  parquetMagicAt,
} from '../detect.ts';
import { asyncBufferOf } from './buffer.ts';
import type { ChunkCache } from './buffer.ts';
import { CODECS, COMPRESSORS, codecOf } from './codecs.ts';
import { columnsOf, stringFromBytes, textOf } from './values.ts';
import type { Column, Leaf, ParquetValue } from './values.ts';

/**
 * The last bytes of a file read for its footer, which hold most footers
 * whole. A longer footer takes one more read, of the rest of it.
 */
export const PARQUET_TAIL_BYTES = 64 << 10;

/** What follows a footer: its length, a little-endian uint32, then the magic. */
const FOOTER_END_BYTES = PARQUET_FOOTER_LENGTH_BYTES + PARQUET_MAGIC_BYTES;

/**
 * The parsers hyparquet is handed. Each hands a value over as it is stored,
 * so textOf writes it at its own precision, and a string comes as its text.
 */
const PARSERS: ParquetParsers = {
  timestampFromMilliseconds: stored,
  timestampFromMicroseconds: stored,
  timestampFromNanoseconds: stored,
  dateFromDays: stored,
  stringFromBytes,
  jsonFromBytes: stored,
  geometryFromBytes: stored,
  geographyFromBytes: stored,
  uuidFromBytes: stored,
};

/** A row as hyparquet assembles it, keyed by top-level field. */
type Assembled = Readonly<Record<string, unknown>>;

/** Table is a Parquet file whose footer has been read. */
export interface Table {
  /**
   * The columns in schema order: each field of a struct, and a list, a map
   * or a repeated field as one.
   */
  readonly columns: readonly Column[];
  readonly rows: number;
  readonly groups: number;
  /** The codecs of the file's pages, in the order CODECS names them. */
  readonly codecs: readonly ParquetCodec[];
  /**
   * The most uncompressed bytes per row among the row groups under rows
   * [start, end), or 0 where there are none. It sizes a decode window.
   */
  bytesPerRow(start: number, end: number): number;
  /** Whether every row group under rows [start, end) has offset indexes. */
  paged(start: number, end: number): boolean;
  /** Rows [start, end) of the file, each cell as textOf writes it. */
  read(start: number, end: number): Promise<string[][]>;
}

/** What the footer says of one row group. */
interface Group {
  /** The row of the file the group starts at. */
  readonly start: number;
  readonly rows: number;
  /** The bytes its column chunks take uncompressed. */
  readonly bytes: number;
  /** Whether each of its column chunks has an offset index. */
  readonly paged: boolean;
}

/**
 * openTable reads the footer of `file`, called `name` in what it refuses.
 * The footer is read through `chunks`, so a small file's rows come from the
 * same read.
 */
export async function openTable(
  name: string,
  file: ByteSource,
  chunks: ChunkCache,
): Promise<Table> {
  const metadata = await footerOf(name, file, chunks);
  const codecs = codecsOf(name, metadata.row_groups);
  refuseTypes(name, metadata.schema);
  return new ParquetTable(name, file, chunks, metadata, codecs);
}

/**
 * The footer of `file`, from one read of its last PARQUET_TAIL_BYTES and one
 * more of the rest of a longer footer. The magic is checked at both ends:
 * where the tail does not reach the start, its first bytes are read beside
 * it.
 */
async function footerOf(
  name: string,
  file: ByteSource,
  chunks: ChunkCache,
): Promise<FileMetaData> {
  const broken = new Refusal({ t: 'parquet-broken', name });
  if (file.size < PARQUET_MIN_BYTES) throw broken;
  const tailStart = Math.max(file.size - PARQUET_TAIL_BYTES, 0);
  const [tail, head] = await Promise.all([
    chunks.slice(file, tailStart, file.size).then((b) => new Uint8Array(b)),
    tailStart === 0 ? undefined : file.read(0, PARQUET_MAGIC_BYTES),
  ]);
  const end = parquetMagicAt(tail, tail.length - PARQUET_MAGIC_BYTES);
  if (end === 'PARE') {
    throw new Refusal({
      t: 'parquet-unsupported',
      name,
      feature: 'encryption',
    });
  }
  if (end !== 'PAR1' || parquetMagicAt(head ?? tail, 0) !== 'PAR1') {
    throw broken;
  }
  const length = new DataView(tail.buffer, tail.byteOffset).getUint32(
    tail.length - FOOTER_END_BYTES,
    true,
  );
  const start = file.size - FOOTER_END_BYTES - length;
  if (start < PARQUET_MAGIC_BYTES) throw broken;
  const rest =
    start < tailStart ? await file.read(start, tailStart - start) : undefined;
  const held = rest === undefined ? tail : concat([rest, tail]);
  const heldStart = file.size - held.length;
  try {
    return parquetMetadata(held.subarray(start - heldStart), {
      parsers: PARSERS,
      geoparquet: false,
    });
  } catch {
    throw broken;
  }
}

/**
 * The codecs of every column chunk in the file, in the order CODECS names
 * them. Encrypted columns, columns kept in other files and codecs uno does
 * not read are refused.
 */
function codecsOf(name: string, groups: readonly RowGroup[]): ParquetCodec[] {
  const found = new Set<ParquetCodec>();
  for (const chunk of groups.flatMap((group) => group.columns)) {
    const encrypted =
      chunk.crypto_metadata !== undefined ||
      chunk.encrypted_column_metadata !== undefined;
    // An empty path names this file, as hyparquet reads it.
    if (encrypted || chunk.file_path) {
      const feature = encrypted ? 'encryption' : 'external-columns';
      throw new Refusal({ t: 'parquet-unsupported', name, feature });
    }
    found.add(codecOf(name, chunk.meta_data?.codec));
  }
  return CODECS.filter((codec) => found.has(codec));
}

/** Refuses a column of a type uno does not read yet. */
function refuseTypes(name: string, schema: readonly SchemaElement[]): void {
  for (const element of schema) {
    const feature = typeFeatureOf(element);
    if (feature !== undefined) {
      throw new Refusal({ t: 'parquet-unsupported', name, feature });
    }
  }
}

/**
 * The type uno does not read yet that an element is annotated with. A
 * VARIANT is one: hyparquet decodes its decimals as floats and its dates
 * and timestamps as bare counts, and a cell written wrong is worse than a
 * file refused by name.
 */
function typeFeatureOf({
  converted_type: converted,
  logical_type: logical,
}: SchemaElement): ParquetFeature | undefined {
  if (converted === 'INTERVAL' || logical?.type === 'INTERVAL') {
    return 'interval';
  }
  if (converted === 'BSON' || logical?.type === 'BSON') return 'bson';
  return logical?.type === 'VARIANT' ? 'variant' : undefined;
}

/** ParquetTable is a Table over the footer it was opened with. */
class ParquetTable implements Table {
  readonly columns: readonly Column[];
  readonly rows: number;
  readonly groups: number;
  readonly codecs: readonly ParquetCodec[];
  private readonly spans: readonly Group[];
  private readonly leaves: readonly Leaf[];
  /** The footer as hyparquet is handed it. */
  private readonly plain: FileMetaData;

  private readonly file: ByteSource;
  private readonly chunks: ChunkCache;

  constructor(
    name: string,
    file: ByteSource,
    chunks: ChunkCache,
    metadata: FileMetaData,
    codecs: readonly ParquetCodec[],
  ) {
    this.file = file;
    this.chunks = chunks;
    this.codecs = codecs;
    try {
      this.leaves = columnsOf(metadata.schema);
    } catch {
      throw new Refusal({ t: 'parquet-broken', name });
    }
    this.plain = withoutDecimals(metadata);
    this.columns = this.leaves.map((leaf) => leaf.column);
    this.spans = groupsOf(metadata.row_groups);
    this.groups = this.spans.length;
    const last = this.spans.at(-1);
    this.rows = last === undefined ? 0 : last.start + last.rows;
  }

  bytesPerRow(start: number, end: number): number {
    const under = this.under(start, end);
    return Math.max(0, ...under.map((span) => span.bytes / span.rows));
  }

  paged(start: number, end: number): boolean {
    return this.under(start, end).every((span) => span.paged);
  }

  /** The row groups that hold any of rows [start, end). */
  private under(start: number, end: number): Group[] {
    // An empty group's start can lie inside the range, but it holds none.
    return this.spans.filter(
      (span) =>
        span.rows > 0 && span.start < end && start < span.start + span.rows,
    );
  }

  async read(start: number, end: number): Promise<string[][]> {
    if (end <= start) return [];
    const rows = await this.assembled(start, end);
    return rows.map((row) =>
      this.leaves.map((leaf) => textOf(leaf, valueAt(row, leaf.path))),
    );
  }

  /**
   * Rows [start, end) as hyparquet assembles them. Only the pages that hold
   * them are read where a row group has offset indexes.
   */
  private async assembled(start: number, end: number): Promise<Assembled[]> {
    let rows: Assembled[] = [];
    await parquetRead({
      file: asyncBufferOf(this.file, this.chunks),
      metadata: this.plain,
      rowStart: start,
      rowEnd: end,
      rowFormat: 'object',
      useOffsetIndex: true,
      parsers: PARSERS,
      utf8: false,
      compressors: COMPRESSORS,
      onComplete: (read: Assembled[]) => {
        rows = read;
      },
    });
    return rows;
  }
}

/**
 * `metadata` as hyparquet is handed it, with no DECIMAL annotation, so a
 * decimal comes over as its unscaled integer for textOf to write exactly.
 */
function withoutDecimals(metadata: FileMetaData): FileMetaData {
  return { ...metadata, schema: metadata.schema.map(withoutDecimal) };
}

/** `element` without its DECIMAL annotation, where it has one. */
function withoutDecimal(element: SchemaElement): SchemaElement {
  const decimal =
    element.converted_type === 'DECIMAL' ||
    element.logical_type?.type === 'DECIMAL';
  if (!decimal) return element;
  const plain = { ...element };
  delete plain.converted_type;
  delete plain.logical_type;
  return plain;
}

/**
 * The value of a top-level leaf in an assembled row. A field of a struct is
 * not read, and is null.
 */
function valueAt(row: Assembled, path: readonly string[]): ParquetValue {
  // With PARSERS and no DECIMAL annotation, hyparquet assembles only the
  // values ParquetValue names.
  return path.length === 1 ? (row[path[0]!] as ParquetValue) : null;
}

/** What the footer says of each row group, in file order. */
function groupsOf(groups: readonly RowGroup[]): Group[] {
  let start = 0;
  return groups.map((group) => {
    const rows = Number(group.num_rows);
    const span = {
      start,
      rows,
      bytes: group.columns.reduce(
        (sum, chunk) => sum + Number(chunk.meta_data?.total_uncompressed_size),
        0,
      ),
      paged: group.columns.every((chunk) =>
        Boolean(chunk.offset_index_offset && chunk.offset_index_length),
      ),
    };
    start += rows;
    return span;
  });
}

/** A value as it is stored. */
function stored<T>(value: T): T {
  return value;
}
