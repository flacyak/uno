/**
 * @fileoverview The real engine indexing a file end to end, driven the way
 * the engine tests drive it (harness connect, openOne, indexed, the disk
 * provider), with every read the provider makes written down.
 *
 * The read log places the time a bare pass does not have: before the pass's
 * first read (the file open, the sniff, the request crossing the channel),
 * the pass's own reads, and the reads beside it (the sample rows' block).
 * The final Progress carries the engine's own clock, the time its INDEX
 * telemetry reports, so the channel's share is the client's time minus it.
 */

import { basename } from 'node:path';

import { TUNING } from '@engine';
import type { Tuning } from '@engine';
import type { Provider } from '@plugin';
import { readAhead } from '@store/ahead';
import { diskProvider } from '@store/node';
import { connect, indexed, openOne } from '@core-tests/engine/harness';

/** ReadRecord is one read the provider's source made. */
export interface ReadRecord {
  offset: number;
  length: number;
  startMs: number;
  endMs: number;
}

/** EngineTimes is where one end-to-end index went. */
export interface EngineTimes {
  /** From asking to open to the client holding the complete Progress. */
  totalMs: number;
  /** From asking to open to the open's reply, which waits for the sample rows. */
  openedMs: number;
  /** The engine's own time for the index, as its INDEX telemetry reports it. */
  engineMs: number;
  /** From asking to open to the pass's first read. */
  beforePassMs: number;
  /** From the pass's first read to the client holding the complete Progress. */
  passMs: number;
  /** The pass's reads, and their durations summed. */
  passReads: number;
  passReadMs: number;
  /** The other reads: the sniff, the sample rows' block. */
  otherReads: number;
  otherReadMs: number;
  /** Bytes read from the file over its size. Read-ahead thrown away shows above 1. */
  readFactor: number;
  /** Progress messages the client received. */
  progressMessages: number;
  records: number;
}

/**
 * traced is the disk provider with each read of the sources it opens logged
 * to `log`, under a readAhead of `ahead` when `ahead` is above 1, as the S3
 * provider wraps its reads.
 */
function traced(
  log: ReadRecord[],
  ahead: number,
  size: { bytes: number },
): Provider {
  const disk = diskProvider();
  const { files } = disk;
  return {
    ...disk,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const source = await files.open(ref);
        size.bytes = source.size;
        const read = async (
          offset: number,
          length: number,
        ): Promise<Uint8Array> => {
          const startMs = performance.now();
          const bytes = await source.read(offset, length);
          log.push({
            offset,
            length: bytes.length,
            startMs,
            endMs: performance.now(),
          });
          return bytes;
        };
        return {
          size: source.size,
          version: source.version,
          read: ahead > 1 ? readAhead(read, source.size, ahead) : read,
          close: () => source.close(),
        };
      },
    },
  };
}

/**
 * isPassRead is whether a read is one of the pass's chunks: a whole chunk,
 * or the last one, which ends the file.
 */
function isPassRead(r: ReadRecord, tuning: Tuning, size: number): boolean {
  return (
    r.length === tuning.chunkBytes ||
    (r.offset > 0 && r.offset + r.length === size)
  );
}

/** engineRun opens `path` in a new engine, waits for its index, and closes it. */
export async function engineRun(
  path: string,
  ahead: number,
  tuning: Tuning = TUNING,
): Promise<EngineTimes> {
  const log: ReadRecord[] = [];
  const size = { bytes: 0 };
  const { engine, done } = connect(tuning, [traced(log, ahead, size)]);
  try {
    const asked = performance.now();
    const src = await openOne(engine, { name: basename(path), path });
    const openedMs = performance.now() - asked;

    let progressMessages = 0;
    const finished = indexed(src);
    const told = src.onProgress;
    src.onProgress = (p) => {
      progressMessages++;
      told(p);
    };
    await finished;
    const totalMs = performance.now() - asked;

    const pass = log.filter((r) => isPassRead(r, tuning, size.bytes));
    const other = log.filter((r) => !isPassRead(r, tuning, size.bytes));
    const firstPass = Math.min(...pass.map((r) => r.startMs));
    const sum = (rs: ReadRecord[]): number =>
      rs.reduce((ms, r) => ms + (r.endMs - r.startMs), 0);
    return {
      totalMs,
      openedMs,
      engineMs: src.progress.elapsedMs,
      beforePassMs: firstPass - asked,
      passMs: asked + totalMs - firstPass,
      passReads: pass.length,
      passReadMs: sum(pass),
      otherReads: other.length,
      otherReadMs: sum(other),
      readFactor: log.reduce((n, r) => n + r.length, 0) / size.bytes,
      progressMessages,
      records: src.progress.rows,
    };
  } finally {
    done();
  }
}
