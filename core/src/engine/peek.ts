/**
 * @fileoverview Peek: a preview of a file's header and first rows, read apart
 * from the workspace.
 *
 * `readHead` opens the file, reads one range from the front, and closes it.
 * Only a front that opens as Parquet does costs a second read, of the file's
 * last bytes. `peekHead` detects what those bytes hold, refuses by name what
 * this build does not read, and decodes the rows they hold. It works on bytes
 * already read, so it can be tested on in-memory bytes.
 */

import {
  PARQUET_MAGIC_BYTES,
  labelOf,
  openFormat,
  opensAsParquet,
  refuseUnread,
} from '@ingest';
import type { HeaderMode, StoredHead } from '@ingest';
import type { Peeked } from './protocol.ts';
import { bytesSource, headerModeOf, openWith } from '@store';
import type { FileHandler, FileRef } from '@store';

/**
 * How many bytes a peek reads from the front of a file. This is the only
 * read a peek makes, whatever the file's size.
 */
export const PEEK_BYTES = 64 << 10;

/** How many rows under the header a peek returns. */
export const PEEK_ROWS = 20;

/** The front of a file, and the size of the whole file. */
export interface Head {
  bytes: Uint8Array;
  size: number;
  /**
   * The file's last PARQUET_MAGIC_BYTES, read only where the front opens as
   * Parquet does, which only they confirm.
   */
  tail?: Uint8Array;
}

/** Optional overrides for the byte and row limits of `peek`. */
export interface PeekLimits {
  bytes?: number;
  rows?: number;
}

/**
 * readHead opens ref through the first handler that claims it, reads up to
 * `limit` bytes from the front in one call, and closes the file. A short read
 * is taken as the end of the file. A front that opens as Parquet does has the
 * file's tail read too.
 */
export async function readHead(
  handlers: readonly FileHandler[],
  ref: FileRef,
  limit: number = PEEK_BYTES,
): Promise<Head> {
  const file = await openWith(handlers, ref);
  try {
    const bytes = await file.read(0, Math.min(limit, file.size));
    const tail = opensAsParquet(bytes)
      ? await file.read(file.size - PARQUET_MAGIC_BYTES, PARQUET_MAGIC_BYTES)
      : undefined;
    return { bytes, size: file.size, tail };
  } finally {
    await file.close();
  }
}

/**
 * peekHead decodes the header and the first rows out of a head already
 * read, once what the file holds is something this build reads.
 *
 * The format is detected over a `bytesSource` of the head's bytes, so
 * `openFormat` stays within them.
 */
export async function peekHead(
  name: string,
  head: Head,
  rows: number = PEEK_ROWS,
  header: HeaderMode = 'first',
): Promise<Peeked> {
  await refuseUnread(name, storedHead(head));
  const format = await openFormat(name, bytesSource(head.bytes), header);

  // Whether the head holds the whole file.
  const whole = head.bytes.length >= head.size;

  const starts: number[] = [];
  const scanner = format.scanner((offset) => {
    if (starts.length <= rows) starts.push(offset); // keep one start past the rows wanted
  });
  scanner.push(head.bytes.subarray(format.dataStart), format.dataStart);

  let records: string[][] = [];
  if (starts.length > 0) {
    // When the head stops short of the end of the file, its last record is cut
    // off, so it is dropped. Every row returned is a whole one.
    const stop =
      starts.length > rows
        ? starts[rows]! // the extra start bounds the last wanted row
        : whole
          ? head.bytes.length
          : starts[starts.length - 1]!; // drop the cut-off record
    records = format.decode(head.bytes.subarray(starts[0], stop));
  }

  // Pad short rows and drop fields past the header's width, so every row is
  // as wide as the header.
  const width = format.columns.length;
  const rowsOut = records.map((r) =>
    Array.from({ length: width }, (_, i) => r[i] ?? ''),
  );

  return { label: labelOf(format), header: format.columns, rows: rowsOut };
}

/**
 * storedHead is a head as detection reads it. Its tail is the one readHead
 * read, or its own end where it holds the whole file.
 */
function storedHead(head: Head): StoredHead {
  const whole = head.bytes.length >= head.size;
  const end = head.tail ?? (whole ? head.bytes : undefined);
  return {
    bytes: head.bytes,
    size: head.size,
    tail: (length) =>
      end === undefined || end.length < length
        ? Promise.reject(new Error('the head was read without its tail'))
        : Promise.resolve(end.subarray(end.length - length)),
  };
}

/** peek reads the front of ref and returns its header and first rows. */
export async function peek(
  handlers: readonly FileHandler[],
  ref: FileRef,
  limits: PeekLimits = {},
): Promise<Peeked> {
  const header = headerModeOf(ref);
  return peekHead(
    ref.name,
    await readHead(handlers, ref, limits.bytes),
    limits.rows,
    header,
  );
}
