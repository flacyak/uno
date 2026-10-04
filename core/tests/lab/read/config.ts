/**
 * @fileoverview What one measured configuration is: the file, the cache
 * state, the chunk size, the thread pool, and the way the pass reads.
 */

import { unreachable } from '@never';

import type { Buffers } from './reader.ts';

/** Bytes in a mebibyte. */
export const MB = 1 << 20;

/** The chunk size the engine reads at today. */
export const ENGINE_CHUNK = 8 * MB;

/** libuv's thread pool size when UV_THREADPOOL_SIZE is unset. */
export const DEFAULT_UV_THREADS = 4;

/** Which file a configuration reads: the 96 MB lab file or the 2.5 GB one. */
export type FileRole = 'mid' | 'big';

/** Cold drops the file's cached pages before every sample. */
export type Cache = 'warm' | 'cold';

/**
 * Method is how the pass runs.
 *
 * - stock: the engine's indexPass over nodeSource.
 * - split: indexPass with timers, over nodeSource.
 * - pipe: the lab pass over `chunks`.
 * - engine: the whole engine, as the harness drives it.
 *
 * `ahead` above 1 wraps the source's reads in readAhead, as the S3 provider
 * does; 1 leaves them as they are.
 */
export type Method =
  | { kind: 'stock'; ahead: number }
  | { kind: 'split'; ahead: number }
  | { kind: 'pipe'; inFlight: number; buffers: Buffers; scan: boolean }
  | { kind: 'engine'; ahead: number };

export interface Config {
  file: FileRole;
  cache: Cache;
  chunkBytes: number;
  /** UV_THREADPOOL_SIZE for the process the configuration runs in. */
  uvThreads: number;
  method: Method;
}

/** What the bench hands the child process that runs one configuration. */
export interface Job {
  config: Config;
  /** The file the configuration reads. */
  path: string;
  /** A smaller file of the same rows, read once first to warm the code. */
  warmupPath: string;
  samples: number;
}

/** idOf names a configuration, the same way every run. */
export function idOf(c: Config): string {
  const m = c.method;
  let how: string;
  switch (m.kind) {
    case 'stock':
    case 'split':
    case 'engine':
      how = `${m.kind}.ahead${m.ahead}`;
      break;
    case 'pipe':
      how = `${m.scan ? 'pipe' : 'readonly'}.inflight${m.inFlight}.${m.buffers}`;
      break;
    default:
      return unreachable(m);
  }
  return `${c.file}.${c.cache}.${how}.chunk${c.chunkBytes / MB}mb.uv${c.uvThreads}`;
}
