/**
 * @fileoverview The messages between a ScanPool and its workers.
 */

import type { ChunkScan } from './speculate.ts';

/** Job asks a worker to scan one chunk. */
export interface Job {
  readonly id: number;
  /** The chunk, its buffer transferred or shared. */
  readonly bytes: Uint8Array;
  readonly base: number;
  readonly sep: number;
}

/**
 * Reply is a worker's answer. Each carries the CPU time the worker's thread
 * has used so far, in microseconds, user and system together.
 */
export type Reply =
  | { readonly kind: 'ready'; readonly cpuMicros: number }
  | {
      readonly kind: 'done';
      readonly id: number;
      readonly scan: ChunkScan;
      readonly cpuMicros: number;
    }
  | {
      readonly kind: 'failed';
      readonly id: number;
      readonly message: string;
      readonly cpuMicros: number;
    };
