/**
 * @fileoverview A Parquet file as hyparquet reads it: an AsyncBuffer over a
 * ByteSource, with the slices it reads held in a ChunkCache that every part
 * of a View shares.
 */

import type { AsyncBuffer } from 'hyparquet/src/index.js';

import type { ByteSource } from '@store';

/** Stored bytes of column chunks a View holds, across all of its parts. */
export const CHUNK_CACHE_BYTES = 32 << 20;

/** ChunkCache holds slices of files read through it, up to a budget. */
export interface ChunkCache {
  /**
   * Stored bytes [start, end) of one file, from a held slice that contains
   * them, or one read. The range lies inside the file.
   */
  slice(file: ByteSource, start: number, end: number): Promise<ArrayBuffer>;
  /** Bytes of the slices held, including those still being read. */
  readonly held: number;
}

/** chunkCache is an empty ChunkCache that holds up to `budget` bytes. */
export function chunkCache(budget: number): ChunkCache {
  return new Chunks(budget);
}

/**
 * asyncBufferOf is `file` as hyparquet reads it. A slice is read through
 * `cache`, with its ends taken as ArrayBuffer.slice takes them.
 */
export function asyncBufferOf(
  file: ByteSource,
  cache: ChunkCache,
): AsyncBuffer {
  const at = (i: number): number =>
    Math.min(Math.max(i < 0 ? file.size + i : i, 0), file.size);
  return {
    byteLength: file.size,
    slice: (start, end = file.size) => cache.slice(file, at(start), at(end)),
  };
}

/** One slice of a file, held from the moment its read starts. */
interface Chunk {
  readonly file: ByteSource;
  readonly start: number;
  readonly end: number;
  readonly bytes: Promise<Uint8Array>;
}

/**
 * Chunks is a ChunkCache. The slice used least recently goes first, and a
 * slice larger than the whole budget is read and not held.
 */
class Chunks implements ChunkCache {
  /** Oldest use first. */
  private readonly chunks = new Set<Chunk>();
  private heldBytes = 0;
  private readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  get held(): number {
    return this.heldBytes;
  }

  async slice(
    file: ByteSource,
    start: number,
    end: number,
  ): Promise<ArrayBuffer> {
    if (end <= start) return new ArrayBuffer(0);
    const chunk = this.find(file, start, end) ?? this.read(file, start, end);
    const bytes = await chunk.bytes;
    return bytes.slice(start - chunk.start, end - chunk.start).buffer;
  }

  private find(
    file: ByteSource,
    start: number,
    end: number,
  ): Chunk | undefined {
    for (const chunk of this.chunks) {
      if (chunk.file === file && chunk.start <= start && end <= chunk.end) {
        // Re-insert so the slice becomes the newest entry in the Set.
        this.chunks.delete(chunk);
        this.chunks.add(chunk);
        return chunk;
      }
    }
    return undefined;
  }

  private read(file: ByteSource, start: number, end: number): Chunk {
    const chunk = { file, start, end, bytes: file.read(start, end - start) };
    if (end - start > this.budget) return chunk;
    this.chunks.add(chunk);
    this.heldBytes += end - start;
    // A failed read is not held, so the next slice of it reads again.
    chunk.bytes.catch(() => this.drop(chunk));
    for (const oldest of this.chunks) {
      if (this.heldBytes <= this.budget) break;
      this.drop(oldest);
    }
    return chunk;
  }

  private drop(chunk: Chunk): void {
    if (this.chunks.delete(chunk)) this.heldBytes -= chunk.end - chunk.start;
  }
}
