/**
 * @fileoverview The read lab's benchmark: what the index pass loses outside
 * the scanner, and what a single-thread change wins back.
 *
 * Run from core/:
 *   node --disable-warning=ExperimentalWarning \
 *     --import ../paths.js tests/lab/read/read.bench.ts \
 *     [--small] [--only <regex over ids>] [--list]
 *
 * Each configuration runs in a child process of its own (child.ts), several
 * samples each, and keeps the min and median of every number. The questions:
 *
 * - a: the pass as it is, split into awaiting reads, scanning and the rest.
 * - b: the next read in flight during the scan, by readAhead or a lab pass.
 * - c: chunk sizes from 1 to 32 MB, by time and peak resident memory.
 * - d: a fresh zeroed array per read, an unzeroed one, or a reused buffer.
 * - e: UV_THREADPOOL_SIZE 4, 8 and 16 with many reads in flight.
 * - f: the real engine end to end against the bare pass on the same file.
 *
 * The full run reads the 96 MB lab file and the 2.5 GB fixture. `--small`
 * reads a 24 MB file in place of the first and the 96 MB file in place of
 * the second, two samples each, to prove the run works. The JSON it ends on
 * is printed as the last line of stdout and written to out/lab/read.json.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_UV_THREADS, ENGINE_CHUNK, MB, idOf } from './config.ts';
import type { Cache, Config, FileRole, Job, Method } from './config.ts';
import type { ChildReport, Sample } from './child.ts';
import {
  BIG_FILE,
  FULL_REPEATS,
  SMALL_REPEATS,
  filesystemOf,
  repeatedFile,
} from './fixture.ts';
import type { Buffers } from './reader.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
const PATHS = fileURLToPath(new URL('../../../../paths.js', import.meta.url));
const OUT = fileURLToPath(
  new URL('../../../out/lab/read.json', import.meta.url),
);

const NODE_FLAGS = [
  '--disable-warning=ExperimentalWarning',
  '--expose-gc',
  '--import',
  PATHS,
];

/** The most bytes a child may print. */
const CHILD_OUTPUT_BYTES = 16 * MB;

const small = process.argv.includes('--small');
/** --list prints the configurations it would run, and runs none. */
const list = process.argv.includes('--list');
const onlyAt = process.argv.indexOf('--only');
const only =
  onlyAt >= 0 ? new RegExp(process.argv[onlyAt + 1] ?? '') : undefined;

/** Samples per configuration, by the file it reads. */
const SAMPLES: Record<FileRole, number> = small
  ? { mid: 2, big: 2 }
  : { mid: 5, big: 3 };

const BOTH: readonly Cache[] = ['warm', 'cold'];
/** Chunk sizes for question c, in MB. */
const CHUNKS_MB = [1, 2, 4, 8, 16, 32];
/** readAhead depths for question b. */
const AHEADS = [2, 3, 4];
/** Thread pool sizes for question e. */
const UV_THREADS = [4, 8, 16];
/** The chunk and the reads in flight question e keeps the pool busy with. */
const MANY_CHUNK = 1 * MB;
const MANY_IN_FLIGHT = 15;

/**
 * A chunk small enough for a reused buffer to stay in the CPU's caches
 * between the read and the scan, tried on the 2.5 GB file beside 8 MB.
 */
const SMALL_CHUNK = 2 * MB;

function pipe(inFlight: number, buffers: Buffers, scan = true): Method {
  return { kind: 'pipe', inFlight, buffers, scan };
}

/** The pass as the engine runs it, with timers. */
const TODAY: Method = { kind: 'split', ahead: 1 };
/** One read at a time into one reused buffer. */
const REUSED = pipe(0, 'reused');
/** The next read in flight during each scan, into two reused buffers. */
const DOUBLE = pipe(1, 'reused');
/** Reading alone, as today's pass reads. */
const READ_ONLY = pipe(0, 'fresh', false);

/** Planned is a configuration and the questions it answers. */
interface Planned {
  config: Config;
  questions: Set<string>;
}

/** plan lists every configuration once, with the questions it answers. */
function plan(): Map<string, Planned> {
  const planned = new Map<string, Planned>();
  const add = (
    question: string,
    file: FileRole,
    cache: Cache,
    method: Method,
    chunkBytes = ENGINE_CHUNK,
    uvThreads = DEFAULT_UV_THREADS,
  ): void => {
    const config: Config = { file, cache, chunkBytes, uvThreads, method };
    const id = idOf(config);
    const seen = planned.get(id);
    if (seen === undefined)
      planned.set(id, { config, questions: new Set([question]) });
    else seen.questions.add(question);
  };

  for (const cache of BOTH) {
    // a: the pass as it is, whole and split, and its reads alone.
    add('a', 'mid', cache, { kind: 'stock', ahead: 1 });
    add('a', 'mid', cache, TODAY);
    add('a', 'mid', cache, READ_ONLY);
    add('a', 'big', cache, TODAY);

    // b: reads in flight during the scan, by readAhead and by the lab pass.
    for (const depth of AHEADS)
      add('b', 'mid', cache, { kind: 'split', ahead: depth });
    add('b', 'mid', cache, pipe(1, 'fresh'));
    add('b', 'mid', cache, DOUBLE);
    add('b', 'mid', cache, pipe(3, 'reused'));

    // c: chunk sizes for today's pass and the double buffer, and for one
    // reused buffer while the cache is warm.
    for (const mb of CHUNKS_MB) {
      add('c', 'mid', cache, TODAY, mb * MB);
      add('c', 'mid', cache, DOUBLE, mb * MB);
      if (cache === 'warm') add('c', 'mid', cache, REUSED, mb * MB);
    }

    // d: where a read lands.
    for (const buffers of ['fresh', 'unzeroed', 'reused'] as const) {
      add('d', 'mid', cache, pipe(0, buffers));
    }

    // f: the engine, as it is and with its reads under readAhead.
    add('f', 'mid', cache, { kind: 'engine', ahead: 1 });
    add('f', 'mid', cache, { kind: 'engine', ahead: 2 });
  }
  add('a', 'big', 'cold', READ_ONLY);
  add('b', 'big', 'cold', DOUBLE);
  add('b', 'big', 'cold', DOUBLE, SMALL_CHUNK);
  add('f', 'big', 'warm', { kind: 'engine', ahead: 1 });

  // e: the thread pool with more reads in flight than it has threads.
  for (const uv of UV_THREADS) {
    for (const cache of BOTH) {
      add(
        'e',
        'mid',
        cache,
        pipe(MANY_IN_FLIGHT, 'reused', false),
        MANY_CHUNK,
        uv,
      );
    }
    add('e', 'mid', 'cold', pipe(MANY_IN_FLIGHT, 'reused'), MANY_CHUNK, uv);
  }
  return planned;
}

/** Stat is the min and median of one number over a configuration's samples. */
interface Stat {
  min: number;
  median: number;
}

interface Result {
  id: string;
  questions: string[];
  file: FileRole;
  cache: Cache;
  chunkMB: number;
  uvThreads: number;
  method: Method;
  samples: number;
  baseRssMB: number;
  peakRssMB: number;
  /** Peak over base: what the samples added. */
  addedRssMB: number;
  stats: Record<string, Stat>;
  error?: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** statsOf takes the min and median of every number the samples share. */
function statsOf(samples: Sample[]): Record<string, Stat> {
  const out: Record<string, Stat> = {};
  for (const key of Object.keys(samples[0] ?? {})) {
    const xs = samples.map((s) => s[key]!).filter((x) => Number.isFinite(x));
    if (xs.length === 0) continue;
    out[key] = { min: Math.min(...xs), median: median(xs) };
  }
  return out;
}

/** runChild runs one configuration in a child process and reads its report. */
function runChild(job: Job): ChildReport {
  const out = execFileSync(
    process.execPath,
    [...NODE_FLAGS, CHILD, JSON.stringify(job)],
    {
      encoding: 'utf8',
      env: { ...process.env, UV_THREADPOOL_SIZE: String(job.config.uvThreads) },
      maxBuffer: CHILD_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const last = out.trim().split('\n').at(-1) ?? '';
  return JSON.parse(last) as ChildReport;
}

const began = performance.now();
const paths: Record<FileRole, string> = small
  ? { mid: repeatedFile(SMALL_REPEATS), big: repeatedFile(FULL_REPEATS) }
  : { mid: repeatedFile(FULL_REPEATS), big: BIG_FILE };

const results: Result[] = [];
const planned = [...plan()].filter(
  ([id]) => only === undefined || only.test(id),
);
if (list) {
  for (const [id, { questions }] of planned) {
    process.stdout.write(`${id} ${[...questions].sort().join('')}\n`);
  }
  process.stdout.write(`${planned.length} configurations\n`);
  process.exit(0);
}
for (const [n, [id, { config, questions }]] of planned.entries()) {
  const job: Job = {
    config,
    path: paths[config.file],
    warmupPath: paths.mid,
    samples: SAMPLES[config.file],
  };
  const base = {
    id,
    questions: [...questions].sort(),
    file: config.file,
    cache: config.cache,
    chunkMB: config.chunkBytes / MB,
    uvThreads: config.uvThreads,
    method: config.method,
    samples: job.samples,
  };
  try {
    const report = runChild(job);
    results.push({
      ...base,
      baseRssMB: report.baseRssMB,
      peakRssMB: report.peakRssMB,
      addedRssMB: report.peakRssMB - report.baseRssMB,
      stats: statsOf(report.samples),
    });
    const total = results.at(-1)!.stats['totalMs'];
    process.stderr.write(
      `[${n + 1}/${planned.length}] ${id}: ${total?.median.toFixed(1)} ms median\n`,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    results.push({
      ...base,
      baseRssMB: NaN,
      peakRssMB: NaN,
      addedRssMB: NaN,
      stats: {},
      error,
    });
    process.stderr.write(
      `[${n + 1}/${planned.length}] ${id}: failed: ${error}\n`,
    );
  }
}

// ------------------------------------------------------------ summary

const byId = new Map(results.map((r) => [r.id, r]));

/** The median of `key` for a configuration, or NaN when it did not run. */
function med(config: Config, key = 'totalMs'): number {
  return byId.get(idOf(config))?.stats[key]?.median ?? NaN;
}
function added(config: Config): number {
  return byId.get(idOf(config))?.addedRssMB ?? NaN;
}
function at(
  file: FileRole,
  cache: Cache,
  method: Method,
  chunkBytes = ENGINE_CHUNK,
  uvThreads = DEFAULT_UV_THREADS,
): Config {
  return { file, cache, chunkBytes, uvThreads, method };
}
const PERCENT = 100;

/** How much faster `c` is than `base`, in percent of `base`. */
function saved(base: number, c: number): number {
  return ((base - c) / base) * PERCENT;
}

/**
 * a and b: today's pass beside its reads alone and its scans alone, and the
 * ways of overlapping them. The hypothesis holds where today is near
 * read + scan and an overlap is near max(read, scan).
 */
const hypothesis = (['mid', 'big'] as const).flatMap((file) =>
  BOTH.map((cache) => {
    const today = at(file, cache, TODAY);
    const todayMs = med(today);
    const scanMs = med(today, 'scanMs');
    const readOnlyMs = med(at(file, cache, READ_ONLY));
    const overlaps: Config[] = [
      ...AHEADS.map((depth) =>
        at(file, cache, { kind: 'split', ahead: depth }),
      ),
      at(file, cache, pipe(1, 'fresh')),
      at(file, cache, DOUBLE),
      at(file, cache, pipe(3, 'reused')),
      at(file, cache, DOUBLE, SMALL_CHUNK),
    ];
    const ran = overlaps.filter((c) => Number.isFinite(med(c)));
    const best = ran.reduce<Config | undefined>(
      (b, c) => (b === undefined || med(c) < med(b) ? c : b),
      undefined,
    );
    const bestMs = best === undefined ? NaN : med(best);
    return {
      file,
      cache,
      todayMs,
      waitMs: med(today, 'waitMs'),
      scanMs,
      otherMs: med(today, 'otherMs'),
      readOnlyMs,
      sumPredictionMs: readOnlyMs + scanMs,
      maxPredictionMs: Math.max(readOnlyMs, scanMs),
      /** One reused buffer and no overlap: what reuse alone wins. */
      reusedMs: med(at(file, cache, REUSED)),
      overlapMs: Object.fromEntries(ran.map((c) => [idOf(c), med(c)])),
      bestOverlap: best === undefined ? undefined : idOf(best),
      bestOverlapMs: bestMs,
      savedPct: saved(todayMs, bestMs),
      /** readAhead 2 around nodeSource: the change that touches no pass. */
      ahead2SavedPct: saved(
        todayMs,
        med(at(file, cache, { kind: 'split', ahead: 2 })),
      ),
      doubleSavedPct: saved(todayMs, med(at(file, cache, DOUBLE))),
      doubleSmallChunkSavedPct: saved(
        todayMs,
        med(at(file, cache, DOUBLE, SMALL_CHUNK)),
      ),
    };
  }),
);

/** c: chunk sizes, with each line's wait and scan, so a cache effect shows. */
const chunkSweep = BOTH.flatMap((cache) =>
  CHUNKS_MB.map((mb) => {
    const line = (method: Method): Record<string, number> => {
      const c = at('mid', cache, method, mb * MB);
      return {
        totalMs: med(c),
        waitMs: med(c, 'waitMs'),
        scanMs: med(c, 'scanMs'),
        addedRssMB: added(c),
      };
    };
    return {
      cache,
      chunkMB: mb,
      today: line(TODAY),
      reused: line(REUSED),
      double: line(DOUBLE),
    };
  }),
);

/** d: where a read lands. */
const buffers = BOTH.flatMap((cache) =>
  (['fresh', 'unzeroed', 'reused'] as const).map((kind) => {
    const c = at('mid', cache, pipe(0, kind));
    return {
      cache,
      buffers: kind,
      totalMs: med(c),
      waitMs: med(c, 'waitMs'),
      gcMs: med(c, 'gcMs'),
      addedRssMB: added(c),
    };
  }),
);

/** e: the thread pool. */
const threads = UV_THREADS.map((uv) => ({
  uvThreads: uv,
  readOnlyWarmMs: med(
    at('mid', 'warm', pipe(MANY_IN_FLIGHT, 'reused', false), MANY_CHUNK, uv),
  ),
  readOnlyColdMs: med(
    at('mid', 'cold', pipe(MANY_IN_FLIGHT, 'reused', false), MANY_CHUNK, uv),
  ),
  passColdMs: med(
    at('mid', 'cold', pipe(MANY_IN_FLIGHT, 'reused'), MANY_CHUNK, uv),
  ),
}));

/** f: the engine against the bare pass on the same file. */
const engine = [
  ...BOTH.flatMap((cache) =>
    [1, 2].map((depth) => ({ file: 'mid' as const, cache, depth })),
  ),
  { file: 'big' as const, cache: 'warm' as const, depth: 1 },
].map(({ file, cache, depth }) => {
  const e = at(file, cache, { kind: 'engine', ahead: depth });
  const bare = at(
    file,
    cache,
    depth > 1 ? { kind: 'split', ahead: depth } : TODAY,
  );
  const totalMs = med(e);
  const bareMs = med(bare);
  return {
    file,
    cache,
    ahead: depth,
    engineTotalMs: totalMs,
    bareMs,
    overBareMs: totalMs - bareMs,
    openedMs: med(e, 'openedMs'),
    beforePassMs: med(e, 'beforePassMs'),
    engineIndexMs: med(e, 'engineMs'),
    channelAndClientMs: totalMs - med(e, 'engineMs'),
    enginePassMs: med(e, 'passMs'),
    enginePassReadMs: med(e, 'passReadMs'),
    barePassWaitMs: med(bare, 'waitMs'),
    otherReads: med(e, 'otherReads'),
    otherReadMs: med(e, 'otherReadMs'),
    progressMessages: med(e, 'progressMessages'),
    readFactor: med(e, 'readFactor'),
  };
});

const SECOND_MS = 1000;
/** Bytes in a gibibyte. */
const GB = 1 << 30;
/** What the parts of a configuration's id mean, for whoever reads the JSON. */
const LEGEND = {
  mid: 'the 96 MB lab file (24 MB under --small)',
  big: 'the 2.5 GB fixture (the 96 MB file under --small)',
  cold: "the file's cached pages dropped before every sample",
  stock: "the engine's indexPass over nodeSource, timed whole",
  split: 'indexPass line for line with timers, over nodeSource',
  ahead: 'readAhead depth around the source; ahead1 is none',
  pipe: 'the lab pass: inflightN reads in flight during each scan',
  readonly: 'the lab pass reading the file and scanning nothing',
  fresh: 'a new zeroed Uint8Array per read, as nodeSource does',
  unzeroed: 'a new array per read, not zeroed (Buffer.allocUnsafeSlow)',
  reused: 'a ring of inflight + 1 buffers read into and reused',
  engine: 'harness connect, openOne, indexed, over the disk provider',
  uv: 'UV_THREADPOOL_SIZE of the child process',
  waitMs: 'time awaiting reads',
  scanMs: "time in the scanner, the index's begin calls included",
  otherMs: 'total less wait and scan',
  addedRssMB: 'peak resident memory over the samples less that after warm-up',
};

const report = {
  lab: 'read',
  scale: small ? 'small' : 'full',
  wallSeconds: (performance.now() - began) / SECOND_MS,
  legend: LEGEND,
  machine: {
    cpu: cpus()[0]?.model ?? '',
    threads: cpus().length,
    memoryGB: totalmem() / GB,
    node: process.version,
    kernel: release(),
  },
  files: Object.fromEntries(
    (['mid', 'big'] as const).map((role) => [
      role,
      {
        path: paths[role],
        bytes: statSync(paths[role]).size,
        filesystem: filesystemOf(paths[role]),
      },
    ]),
  ),
  samples: SAMPLES,
  summary: { hypothesis, chunkSweep, buffers, threads, engine },
  results,
};

const line = JSON.stringify(report);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${line}\n`);
process.stdout.write(`${line}\n`);
