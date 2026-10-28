/**
 * @fileoverview A Parquet file as a table of text: its footer, read once when
 * it opens, says its columns, its row groups and the codecs of its pages.
 *
 * A file that uses what uno does not read yet is refused by name as
 * parquet-unsupported, and one whose footer does not decode as
 * parquet-broken.
 */

import { parquetMetadata } from 'hyparquet/src/index.js';
import type { FileMetaData, RowGroup } from 'hyparquet/src/index.js';

import { concat } from '@go';
import { Refusal } from '@said';
import type { ParquetCodec } from '@said';
import type { ByteSource } from '@store';

import {
  PARQUET_FOOTER_LENGTH_BYTES,
  PARQUET_MAGIC_BYTES,
  PARQUET_MIN_BYTES,
  parquetMagicAt,
} from '../detect.ts';
import type { ChunkCache } from './buffer.ts';
import { CODECS, codecOf } from './codecs.ts';
import { columnsOf } from './values.ts';
import type { Column, Leaf } from './values.ts';

/**
 * The last bytes of a file read for its footer, which hold most footers
 * whole. A longer footer takes one more read, of the rest of it.
 */
export const PARQUET_TAIL_BYTES = 64 << 10;

/** What follows a footer: its length, a little-endian uint32, then the magic. */
const FOOTER_END_BYTES = PARQUET_FOOTER_LENGTH_BYTES + PARQUET_MAGIC_BYTES;

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
  return new ParquetTable(name, metadata, codecs);
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

/** ParquetTable is a Table over the footer it was opened with. */
class ParquetTable implements Table {
  readonly columns: readonly Column[];
  readonly rows: number;
  readonly groups: number;
  readonly codecs: readonly ParquetCodec[];

  constructor(
    name: string,
    metadata: FileMetaData,
    codecs: readonly ParquetCodec[],
  ) {
    this.codecs = codecs;
    let leaves: Leaf[];
    try {
      leaves = columnsOf(metadata.schema);
    } catch {
      throw new Refusal({ t: 'parquet-broken', name });
    }
    this.columns = leaves.map((leaf) => leaf.column);
    this.groups = metadata.row_groups.length;
    this.rows = metadata.row_groups.reduce(
      (sum, group) => sum + Number(group.num_rows),
      0,
    );
  }
}
