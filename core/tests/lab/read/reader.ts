/**
 * @fileoverview Three ways to read a range of a file, so the cost of the
 * memory a read lands in can be told apart from the read itself.
 *
 * `fresh` is what nodeSource does today: a new zeroed Uint8Array per read.
 * `unzeroed` is a new array whose memory is not cleared first. `into` reads
 * into an array the caller owns and reuses. All three go through one
 * FileHandle with positional reads, as nodeSource does.
 */

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** Buffers is where each chunk a pass reads lands. */
export type Buffers = 'fresh' | 'unzeroed' | 'reused';

export const BUFFERS: readonly Buffers[] = ['fresh', 'unzeroed', 'reused'];

/** FileReader reads ranges of one file. */
export interface FileReader {
  readonly size: number;
  /** A new zeroed array per read, as nodeSource reads. */
  fresh(offset: number, length: number): Promise<Uint8Array>;
  /** A new array per read, its memory left as the allocator handed it over. */
  unzeroed(offset: number, length: number): Promise<Uint8Array>;
  /** Reads into the front of `buffer` and returns the part filled. */
  into(buffer: Uint8Array, offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** openReader opens `path` for positional reads. */
export async function openReader(path: string): Promise<FileReader> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();

  const want = (offset: number, length: number): number =>
    Math.max(0, Math.min(length, size - offset));

  return {
    size,
    fresh: (offset, length) =>
      fill(fh, new Uint8Array(want(offset, length)), offset),
    unzeroed(offset, length) {
      const raw = Buffer.allocUnsafeSlow(want(offset, length));
      // A plain Uint8Array over the same memory, so the scanner sees the
      // same kind of array in every mode.
      const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
      return fill(fh, view, offset);
    },
    into: (buffer, offset, length) =>
      fill(fh, buffer.subarray(0, want(offset, length)), offset),
    close: () => fh.close(),
  };
}

/**
 * fill reads `buffer.length` bytes from `offset` into `buffer`, looping on
 * short reads as nodeSource does, and returns the part filled.
 */
async function fill(
  fh: FileHandle,
  buffer: Uint8Array,
  offset: number,
): Promise<Uint8Array> {
  let got = 0;
  while (got < buffer.length) {
    const { bytesRead } = await fh.read(
      buffer,
      got,
      buffer.length - got,
      offset + got,
    );
    if (bytesRead === 0) break; // the file shrank since it was opened
    got += bytesRead;
  }
  return got === buffer.length ? buffer : buffer.subarray(0, got);
}
