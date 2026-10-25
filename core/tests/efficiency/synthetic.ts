/**
 * @fileoverview Synthetic files the efficiency tests measure the index pass
 * over, written to the temp directory once and the same on every machine,
 * and the counters the measurements share.
 */

import { closeSync, existsSync, openSync, statSync, writeSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';

import type { ByteSource } from '@store';

/** Rows written per `writeSync`. */
const BATCH = 4096;

const LF = 0x0a;

/** Synthetic is a file of rows: what comes before them, and a generator of them. */
export interface Synthetic {
  /** Where the file is written. */
  readonly path: string;
  /** What comes before the rows: a header line, or nothing. */
  readonly head: string;
  /** The size to write up to, give or take the last batch of rows. */
  readonly bytes: number;
  /** rows yields the file's rows, each ending in its line break. */
  rows(): Generator<string>;
}

/** writeOnce writes the file if absent or short, and returns its row count. */
export function writeOnce(file: Synthetic): number {
  if (existsSync(file.path) && statSync(file.path).size >= file.bytes) {
    return countRows(file);
  }
  const fd = openSync(file.path, 'w');
  let written = writeSync(fd, file.head);
  let count = 0;
  let batch: string[] = [];
  for (const row of file.rows()) {
    batch.push(row);
    count++;
    if (batch.length === BATCH) {
      written += writeSync(fd, batch.join(''));
      batch = [];
      if (written >= file.bytes) break;
    }
  }
  closeSync(fd);
  return count;
}

/** countRows counts the rows of an existing file by replaying the generator. */
function countRows(file: Synthetic): number {
  const size = statSync(file.path).size;
  let at = Buffer.byteLength(file.head);
  let count = 0;
  for (const row of file.rows()) {
    at += Buffer.byteLength(row);
    count++;
    if (at >= size) break;
  }
  return count;
}

/** countNewlines counts LF bytes in a chunk. */
export function countNewlines(chunk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === LF) n++;
  return n;
}

/** collector exposes gc and returns it as a callable. */
export function collector(): () => void {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

/** counted wraps a source and counts the bytes read through it. */
export function counted(src: ByteSource): {
  source: ByteSource;
  bytes: () => number;
} {
  let bytes = 0;
  return {
    bytes: () => bytes,
    source: {
      size: src.size,
      async read(offset, length) {
        const out = await src.read(offset, length);
        bytes += out.length;
        return out;
      },
      close: () => src.close(),
    },
  };
}
