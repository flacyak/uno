/**
 * @fileoverview The Parquet files the Parquet tests open, and sources over
 * them that log each read.
 */

import { bytesSource } from '@store';
import type { ByteSource } from '@store';

/** A source over `bytes`, with each read as [offset, length] in `reads`. */
export function logged(bytes: Uint8Array): {
  source: ByteSource;
  reads: Array<[offset: number, length: number]>;
} {
  const inner = bytesSource(bytes);
  const reads: Array<[offset: number, length: number]> = [];
  const read = (offset: number, length: number): Promise<Uint8Array> => {
    reads.push([offset, length]);
    return inner.read(offset, length);
  };
  const close = (): Promise<void> => inner.close();
  return { reads, source: { size: inner.size, read, close } };
}
