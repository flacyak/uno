/**
 * @fileoverview A Parquet file as a table of text: its footer, read once when
 * it opens, says its columns and its row groups.
 */

import { parquetMetadata } from 'hyparquet/src/index.js';
import type { FileMetaData } from 'hyparquet/src/index.js';

import { concat } from '@go';
import type { ByteSource } from '@store';

import { PARQUET_FOOTER_LENGTH_BYTES, PARQUET_MAGIC_BYTES } from '../detect.ts';
import type { ChunkCache } from './buffer.ts';
import { columnsOf } from './values.ts';
import type { Column } from './values.ts';

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
  return new ParquetTable(await footerOf(file, chunks));
}

/**
 * The footer of `file`, from one read of its last PARQUET_TAIL_BYTES and one
 * more of the rest of a longer footer.
 */
async function footerOf(
  file: ByteSource,
  chunks: ChunkCache,
): Promise<FileMetaData> {
  const tailStart = Math.max(file.size - PARQUET_TAIL_BYTES, 0);
  const tail = new Uint8Array(await chunks.slice(file, tailStart, file.size));
  const length = new DataView(tail.buffer, tail.byteOffset).getUint32(
    tail.length - FOOTER_END_BYTES,
    true,
  );
  const start = file.size - FOOTER_END_BYTES - length;
  const rest =
    start < tailStart ? await file.read(start, tailStart - start) : undefined;
  const held = rest === undefined ? tail : concat([rest, tail]);
  const heldStart = file.size - held.length;
  return parquetMetadata(held.subarray(start - heldStart), {
    geoparquet: false,
  });
}

/** ParquetTable is a Table over the footer it was opened with. */
class ParquetTable implements Table {
  readonly columns: readonly Column[];
  readonly rows: number;
  readonly groups: number;

  constructor(metadata: FileMetaData) {
    this.columns = columnsOf(metadata.schema).map((leaf) => leaf.column);
    this.groups = metadata.row_groups.length;
    this.rows = metadata.row_groups.reduce(
      (sum, group) => sum + Number(group.num_rows),
      0,
    );
  }
}
