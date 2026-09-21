/**
 * @fileoverview ScanPool: worker_threads Workers that scan chunks, the
 * platform half of the parallel index pass on Node.
 *
 * A chunk goes to the worker holding the fewest jobs. A chunk that owns its
 * whole ArrayBuffer is transferred, one on a SharedArrayBuffer is shared,
 * and any other is copied first, since transferring a view of part of a
 * buffer would take the rest of the buffer with it. The begins come back
 * transferred.
 */

import { Worker } from 'node:worker_threads';

import type { Job, Reply } from './messages.ts';
import type { ChunkScanner } from './pass.ts';
import type { ChunkScan } from './speculate.ts';

/**
 * The most jobs a worker holds at once: the one it scans and one queued
 * behind it, so it never waits on the main thread between chunks.
 */
const HELD_PER_WORKER = 2;

const ENTRY = new URL('./worker.ts', import.meta.url);

/** Handoffs counts how chunks reached the workers. */
export interface Handoffs {
  transferred: number;
  shared: number;
  copied: number;
  copiedBytes: number;
}

interface Slot {
  readonly worker: Worker;
  held: number;
  /** The CPU time the worker last reported, in microseconds. */
  cpuMicros: number;
}

interface Waiting {
  resolve(scan: ChunkScan): void;
  reject(err: Error): void;
}

/** Handoff is a chunk as it is posted: its bytes and what moves with them. */
interface Handoff {
  readonly bytes: Uint8Array;
  readonly transfer: ArrayBuffer[];
}

interface Queued {
  readonly job: Job;
  readonly transfer: ArrayBuffer[];
}

/** ScanPool scans chunks on worker threads. */
export class ScanPool implements ChunkScanner {
  readonly size: number;
  readonly handoffs: Handoffs = {
    transferred: 0,
    shared: 0,
    copied: 0,
    copiedBytes: 0,
  };
  private readonly slots: Slot[];
  private readonly queue: Queued[] = [];
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 0;
  private failure: Error | undefined;
  private closing = false;

  private constructor(slots: Slot[]) {
    this.slots = slots;
    this.size = slots.length;
    for (const slot of slots) {
      slot.worker.on('message', (reply: Reply) => this.settle(slot, reply));
      slot.worker.on('error', (err: Error) => this.fail(err));
      slot.worker.on('exit', (code: number) => {
        if (!this.closing) this.fail(new Error(`a worker exited with ${code}`));
      });
    }
  }

  /** start starts `size` workers and resolves once every one is ready. */
  static async start(size: number): Promise<ScanPool> {
    const workers = Array.from(
      { length: size },
      // No flags: the worker's files need only Node's type stripping.
      () => new Worker(ENTRY, { execArgv: [] }),
    );
    try {
      const ready = await Promise.all(workers.map(readyOf));
      return new ScanPool(
        workers.map((worker, k) => ({
          worker,
          held: 0,
          cpuMicros: ready[k]!,
        })),
      );
    } catch (err) {
      await Promise.all(workers.map((worker) => worker.terminate()));
      throw err;
    }
  }

  scan(chunk: Uint8Array, base: number, sep: number): Promise<ChunkScan> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const id = this.nextId++;
    const { bytes, transfer } = this.handOff(chunk);
    return new Promise<ChunkScan>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.queue.push({ job: { id, bytes, base, sep }, transfer });
      this.pump();
    });
  }

  /** The CPU time every worker has reported so far, in microseconds. */
  cpuMicros(): number {
    let sum = 0;
    for (const slot of this.slots) sum += slot.cpuMicros;
    return sum;
  }

  /** close stops every worker. Jobs not yet answered are refused. */
  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error('the pool was closed'));
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private handOff(chunk: Uint8Array): Handoff {
    const buffer = chunk.buffer;
    if (buffer instanceof SharedArrayBuffer) {
      this.handoffs.shared++;
      return { bytes: chunk, transfer: [] };
    }
    if (chunk.byteOffset === 0 && chunk.byteLength === buffer.byteLength) {
      this.handoffs.transferred++;
      return { bytes: chunk, transfer: [buffer] };
    }
    const own = chunk.slice();
    this.handoffs.copied++;
    this.handoffs.copiedBytes += own.byteLength;
    return { bytes: own, transfer: [own.buffer] };
  }

  /** pump hands queued jobs to the workers holding the fewest. */
  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.leastHeld();
      if (slot.held >= HELD_PER_WORKER) return;
      const { job, transfer } = this.queue.shift()!;
      slot.held++;
      slot.worker.postMessage(job, transfer);
    }
  }

  private leastHeld(): Slot {
    let best = this.slots[0]!;
    for (const slot of this.slots) if (slot.held < best.held) best = slot;
    return best;
  }

  private settle(slot: Slot, reply: Reply): void {
    slot.cpuMicros = reply.cpuMicros;
    if (reply.kind === 'ready') return;
    slot.held--;
    const waiting = this.waiting.get(reply.id);
    this.waiting.delete(reply.id);
    if (reply.kind === 'done') waiting?.resolve(reply.scan);
    else waiting?.reject(new Error(reply.message));
    this.pump();
  }

  /** fail rejects every job, queued or held, once a worker dies. */
  private fail(err: Error): void {
    this.failure = err;
    for (const waiting of this.waiting.values()) waiting.reject(err);
    this.waiting.clear();
    this.queue.length = 0;
  }
}

/** readyOf resolves with a new worker's CPU time once it says it is ready. */
function readyOf(worker: Worker): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onMessage = (reply: Reply): void => {
      if (reply.kind !== 'ready') return;
      worker.off('message', onMessage);
      worker.off('error', reject);
      resolve(reply.cpuMicros);
    };
    worker.on('message', onMessage);
    worker.on('error', reject);
  });
}
