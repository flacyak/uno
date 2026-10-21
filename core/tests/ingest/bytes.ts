/**
 * @fileoverview Helpers the gzip tests share: fixture bytes, and bytes laid
 * end to end and compared.
 */

import { readFileSync } from 'node:fs';

/** The bytes of a fixture in testdata. */
export function fixture(name: string): Uint8Array {
  const url = new URL(`../testdata/${name}`, import.meta.url);
  return new Uint8Array(readFileSync(url));
}

/** Lays bytes end to end. */
export function concat(pieces: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(pieces));
}

/** The first offset two byte arrays differ at, or -1 when they are equal. */
export function differAt(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : length;
}
