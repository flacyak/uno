/**
 * @fileoverview Index passes for the read lab, each timed by where its time
 * goes: awaiting reads, scanning, and the rest.
 *
 * `stockPass` runs the engine's own indexPass and times it whole.
 * `splitPass` is indexPass line for line with timers around the read and the
 * scan, over any ByteSource, readAhead-wrapped or not. `pipePass` reads
 * through `chunks`, which keeps reads in flight while a chunk is scanned and
 * can read into buffers it reuses.
 */

import { indexPass } from '@engine';
import type { RowIndex, Tuning } from '@engine';
import type { Format } from '@ingest';
import { unreachable } from '@never';
import type { ByteSource } from '@store';
import { readAhead } from '@store/ahead';

import type { Buffers, FileReader } from './reader.ts';

/**
 * withReadAhead wraps the source's reads in readAhead, as the S3 provider
 * wraps its own, when `depth` is above 1. At 1 the source is unchanged.
 */
export function withReadAhead(source: ByteSource, depth: number): ByteSource {
  if (depth <= 1) return source;
  const read = (offset: number, length: number): Promise<Uint8Array> =>
    source.read(offset, length);
  return { ...source, read: readAhead(read, source.size, depth) };
}

/** PassTimes is where one pass's time went. */
export interface PassTimes {
  /** From the first read to the last chunk scanned. */
  totalMs: number;
  /** Time awaiting reads, from asking for a chunk to holding it. */
  waitMs: number;
  /** Time in the scanner, the index's begin calls included. */
  scanMs: number;
  /** The rest: the loop, the bookkeeping, the timers themselves. */
  otherMs: number;
  /** Chunks scanned, or read when nothing is scanned. */
  chunks: number;
  /** Bytes the pass was handed. */
  bytes: number;
  /** Records the index counted. */
  records: number;
}

/** PipePlan says how `pipePass` reads. */
export interface PipePlan {
  /** Bytes read at a time. */
  chunkBytes: number;
  /**
   * Reads kept in flight while a chunk is scanned. 0 reads one chunk, then
   * scans it, as indexPass does. 1 is a double buffer.
   */
  inFlight: number;
  buffers: Buffers;
  /** False to read the file and scan nothing, for the cost of reading alone. */
  scan: boolean;
}

/** stockPass runs the engine's indexPass over `source` and times it whole. */
export async function stockPass(
  source: ByteSource,
  format: Format,
  index: RowIndex,
  tuning: Tuning,
): Promise<PassTimes> {
  const started = performance.now();
  await indexPass({
    source,
    format,
    index,
    tuning,
    signal: new AbortController().signal,
    progress: () => undefined,
  });
  const totalMs = performance.now() - started;
  return {
    totalMs,
    waitMs: Number.NaN,
    scanMs: Number.NaN,
    otherMs: Number.NaN,
    chunks: Math.ceil((source.size - format.dataStart) / tuning.chunkBytes),
    bytes: source.size - format.dataStart,
    records: index.counted,
  };
}

/** splitPass is indexPass with a timer around each read and each scan. */
export async function splitPass(
  source: ByteSource,
  format: Format,
  index: RowIndex,
  chunkBytes: number,
): Promise<PassTimes> {
  const scanner = format.scanner((offset) => index.begin(offset));
  let waitMs = 0;
  let scanMs = 0;
  let chunks = 0;
  const started = performance.now();

  for (let at = format.dataStart; at < source.size;) {
    const asked = performance.now();
    const chunk = await source.read(at, Math.min(chunkBytes, source.size - at));
    const held = performance.now();
    waitMs += held - asked;
    if (chunk.length === 0) break;
    scanner.push(chunk, at);
    scanMs += performance.now() - held;
    at += chunk.length;
    index.scanned = at;
    chunks++;
  }
  index.complete = true;

  const totalMs = performance.now() - started;
  return {
    totalMs,
    waitMs,
    scanMs,
    otherMs: totalMs - waitMs - scanMs,
    chunks,
    bytes: index.scanned - format.dataStart,
    records: index.counted,
  };
}

/** Chunk is a run of the file's bytes and where it starts. */
export interface Chunk {
  bytes: Uint8Array;
  offset: number;
}

/**
 * chunks yields the file from `start` to its end, in order, `plan.chunkBytes`
 * at a time.
 *
 * Once it holds a chunk it asks for the next `plan.inFlight` before handing
 * the chunk over, so those reads run while the caller works on it. A reused
 * buffer is one of a ring of `inFlight + 1`: the chunk handed over is never
 * the target of a read in flight. A handed-over chunk stays valid until the
 * next one is asked for.
 *
 * A short read means the file shrank, and ends the run. Leaving early waits
 * for the reads still in flight, so no read lands after the caller moved on.
 */
export async function* chunks(
  reader: FileReader,
  start: number,
  plan: Pick<PipePlan, 'chunkBytes' | 'inFlight' | 'buffers'>,
): AsyncGenerator<Chunk> {
  const ring =
    plan.buffers === 'reused'
      ? Array.from(
          { length: plan.inFlight + 1 },
          () => new Uint8Array(plan.chunkBytes),
        )
      : [];
  let slot = 0;
  const pending: Array<{
    offset: number;
    length: number;
    bytes: Promise<Uint8Array>;
  }> = [];
  let next = start;

  const read = (offset: number, length: number): Promise<Uint8Array> => {
    switch (plan.buffers) {
      case 'fresh':
        return reader.fresh(offset, length);
      case 'unzeroed':
        return reader.unzeroed(offset, length);
      case 'reused': {
        const buffer = ring[slot]!;
        slot = (slot + 1) % ring.length;
        return reader.into(buffer, offset, length);
      }
      default:
        return unreachable(plan.buffers);
    }
  };
  /** Asks for chunks until `count` are pending or the file is all asked for. */
  const ask = (count: number): void => {
    while (pending.length < count && next < reader.size) {
      const length = Math.min(plan.chunkBytes, reader.size - next);
      pending.push({ offset: next, length, bytes: read(next, length) });
      next += length;
    }
  };

  try {
    for (;;) {
      ask(1);
      const head = pending.shift();
      if (head === undefined) return;
      const bytes = await head.bytes;
      if (bytes.length < head.length) {
        if (bytes.length > 0) yield { bytes, offset: head.offset };
        return;
      }
      ask(plan.inFlight);
      yield { bytes, offset: head.offset };
    }
  } finally {
    await Promise.allSettled(pending.map((p) => p.bytes));
  }
}

/** pipePass indexes the file, or only reads it, through `chunks`. */
export async function pipePass(
  reader: FileReader,
  format: Format,
  index: RowIndex,
  plan: PipePlan,
): Promise<PassTimes> {
  const scanner = format.scanner((offset) => index.begin(offset));
  const run = chunks(reader, format.dataStart, plan);
  let waitMs = 0;
  let scanMs = 0;
  let count = 0;
  let bytes = 0;
  const started = performance.now();

  for (;;) {
    const asked = performance.now();
    const step = await run.next();
    const held = performance.now();
    waitMs += held - asked;
    if (step.done === true) break;
    const chunk = step.value;
    if (plan.scan) scanner.push(chunk.bytes, chunk.offset);
    scanMs += performance.now() - held;
    bytes += chunk.bytes.length;
    index.scanned = chunk.offset + chunk.bytes.length;
    count++;
  }
  index.complete = true;

  const totalMs = performance.now() - started;
  return {
    totalMs,
    waitMs,
    scanMs,
    otherMs: totalMs - waitMs - scanMs,
    chunks: count,
    bytes,
    records: index.counted,
  };
}
