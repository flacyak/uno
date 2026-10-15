/**
 * @fileoverview The remote lab's benchmark: what local resources buy an
 * object in a bucket that waits a fixed time before every answer.
 *
 *   index   the time to index the object at each latency, with each number
 *           of chunks in flight and each chunk size
 *   paced   the same with each answer's body capped at a single stream's
 *           rate, at the default latency
 *   reopen  a second open and 20 band jumps at the default latency: today,
 *           with the index kept (t3/kept-index), with bucket pages kept on
 *           disk (cache.ts), with both, and with a page budget below the
 *           object's size
 *
 * Each configuration runs `samples` times, round by round, and keeps the
 * min and median. The last line on stdout is the result as one line of
 * JSON, which is also written to out/lab/remote.json.
 *
 * Run from core/:
 *   node --disable-warning=ExperimentalWarning \
 *     --import ../paths.js tests/lab/remote/bench.ts
 * Options: --repeats N (the object is the fixture's rows N times; 400 is
 * 96 MB), --samples N, --pages DIR (where pages are kept; it is emptied).
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { TUNING } from '@engine';
import type { RowIndex, Tuning } from '@engine';
import { AHEAD } from '@store/ahead';
import { ROWS, repeated } from '@core-tests/testdata/sales-q3';
import { PAGE_BYTES } from './cache.ts';
import { diskBytes } from './disk.ts';
import { farBucket } from './far.ts';
import type { FarBucket } from './far.ts';
import {
  engineSession,
  jumpRows,
  keptSession,
  watched,
  wholeIndex,
} from './session.ts';
import type { Reach, Session, Step } from './session.ts';
import { Tally } from './tally.ts';

const MB = 1 << 20;
/** 96 MB and 1,924,800 rows, as tests/performance/index.test.ts. */
const REPEATS = 400;
const SAMPLES = 3;

const LATENCIES_MS = [20, 50, 100];
const DEFAULT_LATENCY_MS = 50;
const FEWEST_AHEAD = 1;
const MOST_AHEAD = 16;
const AHEADS = [FEWEST_AHEAD, 2, AHEAD, 8, MOST_AHEAD];
/** The ends of the ahead range and the default, for the trimmed rows. */
const AHEAD_CORNERS = [FEWEST_AHEAD, AHEAD, MOST_AHEAD];
const CHUNKS_MB = [2, 8, 16];
const DEFAULT_CHUNK_MB = TUNING.chunkBytes / MB;

/** One answer's rate in `paced`: a single S3 GET stream, roughly. */
const STREAM_BYTES_PER_SECOND = 64 * MB;

const JUMPS = 20;
/** A page budget the object fits in with room to spare. */
const ROOMY_BUDGET = 1 << 30;
/** A page budget a third of the default object, as a full cache would leave. */
const TIGHT_BUDGET = 32 * MB;

const exec = promisify(execFile);
/** Milliseconds in a second. */
const SECOND_MS = 1000;

/** Stats is the min and median of a configuration's samples. */
interface Stats {
  min: number;
  median: number;
}

function stats(values: readonly number[]): Stats {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: round(sorted[0]!), median: round(median) };
}

/** Tenths of a millisecond are as fine as a timing here is worth. */
function round(n: number): number {
  const TENTHS = 10;
  return Math.round(n * TENTHS) / TENTHS;
}

const { values: args } = parseArgs({
  options: {
    repeats: { type: 'string', default: String(REPEATS) },
    samples: { type: 'string', default: String(SAMPLES) },
    pages: {
      type: 'string',
      default: join(homedir(), '.cache', 'uno-lab', 'remote', 'pages'),
    },
  },
});
const repeats = Number(args.repeats);
const samples = Number(args.samples);
const pagesDir = args.pages;
const rows = repeats * ROWS;

// ------------------------------------------------------------ index grid

/** IndexCase is one configuration of the index grid. */
interface IndexCase {
  latencyMs: number;
  ahead: number;
  chunkMB: number;
  /** Bytes a second each answer's body is capped at, or undefined. */
  paced?: number;
}

/**
 * indexCases is every ahead at every latency at the default chunk size,
 * and the other chunk sizes at the ends of the ahead range and the default.
 */
function indexCases(): IndexCase[] {
  const out: IndexCase[] = [];
  for (const latencyMs of LATENCIES_MS) {
    for (const chunkMB of CHUNKS_MB) {
      const aheads = chunkMB === DEFAULT_CHUNK_MB ? AHEADS : AHEAD_CORNERS;
      for (const ahead of aheads) out.push({ latencyMs, ahead, chunkMB });
    }
  }
  return out;
}

/** pacedCases is the default latency, the ahead corners, every chunk size at the default ahead. */
function pacedCases(): IndexCase[] {
  const out: IndexCase[] = [];
  for (const chunkMB of CHUNKS_MB) {
    const aheads =
      chunkMB === DEFAULT_CHUNK_MB ? AHEAD_CORNERS : [AHEAD, MOST_AHEAD];
    for (const ahead of aheads) {
      out.push({
        latencyMs: DEFAULT_LATENCY_MS,
        ahead,
        chunkMB,
        paced: STREAM_BYTES_PER_SECOND,
      });
    }
  }
  return out;
}

/** IndexSample is one run of one IndexCase. */
interface IndexSample {
  openMs: number;
  /** From asking for the object to its last row indexed. */
  indexedMs: number;
  requests: number;
  bytes: number;
  peak: number;
}

async function indexOnce(far: FarBucket, c: IndexCase): Promise<IndexSample> {
  const tuning: Tuning = { ...TUNING, chunkBytes: c.chunkMB * MB };
  const tally = new Tally(c.paced);
  const s = await engineSession(
    { endpoint: far.endpoint, tally, ahead: c.ahead },
    tuning,
    [],
  );
  checkRows(s);
  return {
    openMs: s.open.ms,
    indexedMs: s.open.ms + s.index.ms,
    requests: s.open.requests + s.index.requests,
    bytes: s.open.bytes + s.index.bytes,
    peak: s.peak,
  };
}

function checkRows(s: Session): void {
  if (s.rows !== rows) throw new Error(`indexed ${s.rows} rows of ${rows}`);
}

// ------------------------------------------------------------ reopen

/** ReopenCase is one way a second open of the object can go. */
interface ReopenCase {
  name: string;
  /** What the case is, in words, for whoever reads the JSON. */
  says: string;
  run(): Promise<Session>;
}

/** freshPages empties the pages folder and returns a store over it. */
async function freshPages(budget: number): Promise<ReturnType<typeof watched>> {
  await rm(pagesDir, { recursive: true, force: true });
  await mkdir(pagesDir, { recursive: true });
  return watched(diskBytes(pagesDir, budget));
}

/**
 * coldPages writes the kept pages to the disk and drops them from the page
 * cache, so the next session reads them off the drive, as a later day's
 * open would.
 */
async function coldPages(): Promise<void> {
  const files = (await readdir(pagesDir)).map((n) => join(pagesDir, n));
  if (files.length === 0) return;
  await exec('sync', files);
  // One shell for every file: dd drops a file's clean pages from the cache.
  await exec('sh', [
    '-c',
    'for f; do dd if="$f" iflag=nocache count=0 status=none; done',
    'sh',
    ...files,
  ]);
}

function reopenCases(far: FarBucket, kept: RowIndex): ReopenCase[] {
  const jumps = jumpRows(rows, JUMPS);
  const reach = (keep?: Reach['keep']): Reach => ({
    endpoint: far.endpoint,
    tally: new Tally(),
    keep,
  });
  const keepIn = (store: ReturnType<typeof watched>): Reach['keep'] => ({
    store,
    pageBytes: PAGE_BYTES,
  });
  /** The store the warm cases read, filled by `cached first`. */
  let warm: ReturnType<typeof watched> | undefined;
  const warmed = (): ReturnType<typeof watched> => {
    if (warm === undefined) throw new Error('the pages were never kept');
    return warm;
  };

  return [
    {
      name: 'today',
      says: 'any open today, first or second: the whole object is scanned',
      run: () => engineSession(reach(), TUNING, jumps),
    },
    {
      name: 'kept index',
      says: 't3/kept-index: the scan is skipped, every band still asks the bucket',
      run: () => keptSession(reach(), TUNING, kept, jumps),
    },
    {
      name: 'pages first',
      says: 'a first open keeping bucket pages on disk, budget roomy',
      async run() {
        warm = await freshPages(ROOMY_BUDGET);
        const s = await engineSession(reach(keepIn(warm)), TUNING, jumps);
        await warm.idle();
        return s;
      },
    },
    {
      name: 'pages second',
      says: 'a second open over the pages the first kept, read off the drive',
      async run() {
        await coldPages();
        return engineSession(reach(keepIn(warmed())), TUNING, jumps);
      },
    },
    {
      name: 'kept index and pages',
      says: 'a second open with the index kept and the pages kept',
      async run() {
        await coldPages();
        return keptSession(reach(keepIn(warmed())), TUNING, kept, jumps);
      },
    },
    {
      name: 'pages second, tight budget',
      says: `a second open over pages kept within ${TIGHT_BUDGET / MB} MB, filled at no latency`,
      async run() {
        const store = await freshPages(TIGHT_BUDGET);
        await far.latency(0);
        await engineSession(reach(keepIn(store)), TUNING, jumps);
        await store.idle();
        await far.latency(DEFAULT_LATENCY_MS);
        await coldPages();
        return engineSession(reach(keepIn(store)), TUNING, jumps);
      },
    },
  ];
}

/** StepStats is one stretch of a ReopenCase over every sample. */
interface StepStats {
  ms: Stats;
  requests: Stats;
  bytes: Stats;
}

function stepStats(steps: readonly Step[]): StepStats {
  return {
    ms: stats(steps.map((s) => s.ms)),
    requests: stats(steps.map((s) => s.requests)),
    bytes: stats(steps.map((s) => s.bytes)),
  };
}

// ------------------------------------------------------------ main

async function main(): Promise<void> {
  const began = performance.now();
  const object = repeated(repeats);
  const far = await farBucket(repeats);
  try {
    // One unrecorded session, so the first configuration runs warm code.
    await far.latency(0);
    checkRows(
      await engineSession(
        { endpoint: far.endpoint, tally: new Tally() },
        TUNING,
        [],
      ),
    );

    const grid = [...indexCases(), ...pacedCases()];
    const indexRuns = grid.map((): IndexSample[] => []);
    for (let round = 0; round < samples; round++) {
      let latency = -1;
      for (const [i, c] of grid.entries()) {
        if (c.latencyMs !== latency) {
          latency = c.latencyMs;
          await far.latency(latency);
        }
        indexRuns[i]!.push(await indexOnce(far, c));
      }
    }

    const kept = await wholeIndex(object, TUNING);
    await far.latency(DEFAULT_LATENCY_MS);
    const cases = reopenCases(far, kept);
    const reopenRuns = cases.map((): Session[] => []);
    for (let round = 0; round < samples; round++) {
      for (const [i, c] of cases.entries()) {
        await far.latency(DEFAULT_LATENCY_MS);
        const s = await c.run();
        checkRows(s);
        reopenRuns[i]!.push(s);
      }
    }
    await rm(pagesDir, { recursive: true, force: true });

    const indexOf = (c: IndexCase, runs: readonly IndexSample[]) => ({
      ...c,
      openMs: stats(runs.map((r) => r.openMs)),
      indexedMs: stats(runs.map((r) => r.indexedMs)),
      requests: stats(runs.map((r) => r.requests)),
      bytes: stats(runs.map((r) => r.bytes)),
      peak: stats(runs.map((r) => r.peak)),
    });
    const result = {
      name: 'remote',
      object: { bytes: object.length, rows },
      samples,
      tuning: TUNING,
      pageBytes: PAGE_BYTES,
      jumps: JUMPS,
      index: grid
        .map((c, i) => indexOf(c, indexRuns[i]!))
        .filter((r) => r.paced === undefined),
      paced: grid
        .map((c, i) => indexOf(c, indexRuns[i]!))
        .filter((r) => r.paced !== undefined),
      reopen: cases.map((c, i) => {
        const runs = reopenRuns[i]!;
        return {
          name: c.name,
          says: c.says,
          latencyMs: DEFAULT_LATENCY_MS,
          open: stepStats(runs.map((r) => r.open)),
          index: stepStats(runs.map((r) => r.index)),
          bands: {
            ...stepStats(runs.map((r) => r.bands)),
            slowestMs: stats(runs.map((r) => r.bands.slowestMs)),
          },
          total: stepStats(
            runs.map((r) => ({
              ms: r.open.ms + r.index.ms + r.bands.ms,
              requests: r.open.requests + r.index.requests + r.bands.requests,
              bytes: r.open.bytes + r.index.bytes + r.bands.bytes,
            })),
          ),
        };
      }),
      wallSeconds: round((performance.now() - began) / SECOND_MS),
    };

    const line = JSON.stringify(result);
    const out = fileURLToPath(new URL('../../../out/lab/', import.meta.url));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'remote.json'), `${line}\n`);
    console.log(line);
  } finally {
    await far.close();
  }
}

await main();
