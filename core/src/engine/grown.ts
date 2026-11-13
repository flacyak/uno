/**
 * @fileoverview Whether a file on disk grew by an append since its index
 * completed, told from its first and last blocks of rows without reading the
 * rest.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { ByteSource } from '@store';
import type { RowIndex } from './rows.ts';

/**
 * Print is a hash of a file's first block of rows and of its last: the
 * bytes an append leaves as they were, and the last of them the ones a pass
 * seeded from the index reads again.
 */
export interface Print {
  head: string;
  tail: string;
}

/** hashOf is the SHA-256 of `bytes`, in hex. */
export function hashOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * printAt is the print of what `source` holds now where `index` has its
 * first and last blocks. Undefined where the index holds no block.
 */
export async function printAt(
  source: ByteSource,
  index: RowIndex,
): Promise<Print | undefined> {
  const blocks = index.begun;
  if (blocks === 0) return undefined;
  const hashed = async (block: number): Promise<string> => {
    const [start, end] = index.bytesOf(block);
    return hashOf(await source.read(start, end - start));
  };
  return { head: await hashed(0), tail: await hashed(blocks - 1) };
}
