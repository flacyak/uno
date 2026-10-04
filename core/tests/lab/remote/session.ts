/**
 * @fileoverview The sessions the lab measures against an object in a bucket.
 *
 * engineSession is one session today: a fresh engine opens the object,
 * indexes it to the last row, and serves band jumps. keptSession is the same
 * session with the index kept from an earlier open, the way t3/kept-index
 * restores it for a bucket: openFormat sniffs the head, the restored index
 * is whole so the pass reads nothing, and the open waits on the sample rows
 * alone. The engine there is the one on this branch, so keptSession puts
 * the same parts together by hand: the file handler, openFormat, a whole
 * RowIndex and Pages.
 *
 * Either can read through cachedProvider, so pages the bucket sent are read
 * from a local store the next time.
 */

import { BAND_ROWS, Pages, RowIndex, indexPass } from '@engine';
import type { SourceHandle, Tuning } from '@engine';
import { openFormat } from '@ingest';
import type { Provider } from '@plugin';
import { SAMPLE_ROWS } from '@sheet';
import { bytesSource } from '@store';
import { diskProvider } from '@store/node';
import { s3Provider } from '@store/s3';
import { connect, indexed, openOne } from '@core-tests/engine/harness';
import { HOME_REGION } from '@core-tests/store/regions';
import { KEYS } from '@core-tests/store/standin';
import { cachedProvider } from './cache.ts';
import type { ByteStore } from './cache.ts';
import { REF } from './far.ts';
import type { Cost, Tally } from './tally.ts';

/** Reach is how a session gets to the bucket. */
export interface Reach {
  endpoint: string;
  /** Counts every request the session sends. */
  tally: Tally;
  /** Chunks a sequential reader has in flight. The provider's default when unset. */
  ahead?: number;
  /** Where bucket bytes are kept between opens. Undefined keeps none. */
  keep?: { store: ByteStore; pageBytes: number };
}

/** Step is one stretch of a session: how long it took and what it sent. */
export interface Step extends Cost {
  ms: number;
}

/** Session is what one session cost, stretch by stretch. */
export interface Session {
  /** From asking for the object to its first rows and columns. */
  open: Step;
  /** From the open's answer to the last row indexed. */
  index: Step;
  /** Every band jump, one after the other, and the read-ahead they sent. */
  bands: Step & { slowestMs: number };
  /** Rows the index counted. */
  rows: number;
  /** The most requests out at once. */
  peak: number;
}

/** bucketProvider is the S3 provider over `reach`, keeping pages if asked. */
export function bucketProvider(reach: Reach): Provider {
  const s3 = s3Provider({
    // Signed for the bucket's own region.
    credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
    endpoint: reach.endpoint,
    fetch: reach.tally.fetch,
    ahead: reach.ahead,
  });
  return reach.keep === undefined
    ? s3
    : cachedProvider(s3, reach.keep.store, reach.keep.pageBytes);
}

/**
 * A stride through the jumps that visits each once in a scattered order, so
 * no jump continues the one before it. It shares no factor with the count.
 */
const STRIDE = 7;

/**
 * jumpRows is where `count` band jumps land in `rows` rows: spread evenly
 * from first to last, visited in a scattered order.
 */
export function jumpRows(rows: number, count: number): number[] {
  const room = Math.max(0, rows - BAND_ROWS);
  const spread = Array.from({ length: count }, (_, i) =>
    Math.floor(((i + 0.5) / count) * room),
  );
  if (count % STRIDE === 0) return spread;
  return spread.map((_, i) => spread[(i * STRIDE) % count]!);
}

/** ReadRows reads `count` rows from `first` and says how many came. */
type ReadRows = (first: number, count: number) => Promise<number>;

/**
 * bands makes a band jump to each of `jumps` in turn, then waits for the
 * read-ahead they sent, which counts toward them.
 */
async function bands(
  tally: Tally,
  read: ReadRows,
  jumps: readonly number[],
): Promise<Session['bands']> {
  const mark = tally.mark();
  const started = performance.now();
  let slowestMs = 0;
  for (const first of jumps) {
    const asked = performance.now();
    const got = await read(first, BAND_ROWS);
    slowestMs = Math.max(slowestMs, performance.now() - asked);
    if (got !== BAND_ROWS) {
      throw new Error(`a band at row ${first} came with ${got} rows`);
    }
  }
  const ms = performance.now() - started;
  await tally.quiet();
  return { ms, slowestMs, ...tally.since(mark) };
}

/**
 * engineSession opens the object through a fresh engine tuned by `tuning`,
 * waits for the last row indexed, and makes the band jumps.
 */
export async function engineSession(
  reach: Reach,
  tuning: Tuning,
  jumps: readonly number[],
): Promise<Session> {
  const { tally } = reach;
  const { engine, done } = connect(tuning, [
    diskProvider(),
    bucketProvider(reach),
  ]);
  try {
    tally.resetPeak();
    const begun = tally.mark();
    const started = performance.now();
    const src: SourceHandle = await openOne(engine, REF);
    const opened = performance.now();
    const answered = tally.mark();
    await indexed(src);
    const finished = performance.now();
    const complete = tally.mark();
    const peak = tally.peak;
    const read: ReadRows = async (first, count) =>
      (await src.rows(first, count)).rows.length;
    return {
      open: { ms: opened - started, ...tally.since(begun, answered) },
      index: { ms: finished - opened, ...tally.since(answered, complete) },
      bands: await bands(tally, read, jumps),
      rows: src.progress.rows,
      peak,
    };
  } finally {
    done();
  }
}

/**
 * wholeIndex indexes `object` in memory, which is the index t3/kept-index
 * restores once an earlier open of the same bytes ran to the end: restore
 * copies the kept block starts back as they were written.
 */
export async function wholeIndex(
  object: Uint8Array,
  tuning: Tuning,
): Promise<RowIndex> {
  const source = bytesSource(object);
  const format = await openFormat(REF.name, source);
  const index = new RowIndex(format.dataStart, source.size, tuning);
  await indexPass({
    source,
    format,
    index,
    tuning,
    signal: new AbortController().signal,
    progress: () => undefined,
  });
  return index;
}

/**
 * keptSession opens the object with `kept` standing in for its index, as
 * View.open does on t3/kept-index once RowIndex.restore gives the index
 * back whole, and makes the band jumps.
 *
 * What it sends is what that open sends: the HEAD, the sniff of the head,
 * the blocks the sample rows are in. A bucket names its bytes by version,
 * so that branch reads nothing to check the index. The pass reads nothing,
 * since the index is complete.
 */
export async function keptSession(
  reach: Reach,
  tuning: Tuning,
  kept: RowIndex,
  jumps: readonly number[],
): Promise<Session> {
  const { tally } = reach;
  tally.resetPeak();
  const begun = tally.mark();
  const started = performance.now();
  const source = await bucketProvider(reach).files.open(REF);
  try {
    const format = await openFormat(REF.name, source);
    // RowIndex.restore refuses an index over another start or size.
    if (
      !kept.complete ||
      kept.start !== format.dataStart ||
      kept.size !== source.size
    ) {
      throw new Error('the kept index is over other bytes');
    }
    const pages = new Pages(REF.name, source, format, kept, tuning.cacheBytes);
    // View.open infers the columns' kinds from the sample rows before it
    // answers.
    await pages.rows(0, SAMPLE_ROWS);
    const opened = performance.now();
    const answered = tally.mark();
    const peak = tally.peak;
    const read: ReadRows = async (first, count) =>
      (await pages.rows(first, count)).length;
    return {
      open: { ms: opened - started, ...tally.since(begun, answered) },
      index: { ms: 0, requests: 0, bytes: 0 },
      bands: await bands(tally, read, jumps),
      rows: kept.rows(),
      peak,
    };
  } finally {
    await source.close();
  }
}

/**
 * Watched is a ByteStore that knows when its saves are done, so a session
 * that keeps pages can be followed by one that reads them.
 */
export interface Watched extends ByteStore {
  /** Resolves once every save started so far has finished. */
  idle(): Promise<void>;
}

/** watched wraps `store` so its saves can be waited for. */
export function watched(store: ByteStore): Watched {
  const saving = new Set<Promise<void>>();
  return {
    load: (key) => store.load(key),
    save(key, bytes) {
      const saved = store.save(key, bytes);
      const settled = saved.then(
        () => undefined,
        () => undefined,
      );
      saving.add(settled);
      void settled.then(() => saving.delete(settled));
      return saved;
    },
    async idle() {
      while (saving.size > 0) await Promise.all(saving);
    },
  };
}
