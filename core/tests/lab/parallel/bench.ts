/**
 * @fileoverview Benchmark: the parallel index pass against core's sequential
 * indexPass, on the 96 MB sales fixture in memory and the 2.5 GB one on disk,
 * warm and cold, with 1 to 15 workers.
 *
 * Run from core/:
 *
 *   node --import ../paths.js \
 *     tests/lab/parallel/bench.ts
 *
 * `--small` runs every section at a small scale, to check the benchmark
 * works end to end. `--big PATH` names the 2.5 GB file.
 *
 * Every configuration runs several times; min and median are kept. CPU time
 * is process.cpuUsage, which counts every thread of the process, with the
 * main thread's and the workers' own shown apart. Each parallel index is
 * checked against the sequential one before its time is kept.
 *
 * Progress goes to stderr. The result is one JSON object, printed as the
 * last stdout line and written to out/lab/parallel.json.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, cpus, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { RowIndex, TUNING, indexPass } from '@engine';
import { RecordScanner, peekFormat } from '@ingest';
import type { Format } from '@ingest';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';
import { ROWS, repeated } from '@core-tests/testdata/sales-q3';
import { contextFor, difference } from './indexes.ts';
import { parallelIndexPass, planFor } from './pass.ts';
import { ScanPool } from './pool.ts';
import { SALES, SYNTHETIC, PLAIN, ALTERNATING, QUOTE_RUN } from './shapes.ts';
import type { Shape } from './shapes.ts';
import { LINE, NONE, scanChunk, separatorOf, trace } from './speculate.ts';
import type { State } from './speculate.ts';
import { Stitcher } from './stitch.ts';
import type { StitchMode } from './stitch.ts';

/** The 2.5 GB fixture: sales-q3.csv's rows 10,400 times over. */
const BIG =
  '/home/hech/Documents/opensource/uno/internal/grid/tests/testdata/generated/sales-q3-50m.csv';
/** Where this lab keeps files that must really be on disk. */
const LAB_DISK = join(homedir(), '.cache', 'uno-lab', 'parallel');
const OUT = fileURLToPath(new URL('../../../out/lab/', import.meta.url));
const OUT_FILE = join(OUT, 'parallel.json');

const MB = 1 << 20;
const MICROS_PER_MS = 1000;
const MS_PER_SECOND = 1000;
/** Reads a pass keeps in flight: Node's file reads run on libuv's 4 threads. */
const READS = 4;
/** Digits kept in reported milliseconds and ratios. */
const DIGITS = 2;

/** Scale is how much a run does. */
interface Scale {
  readonly name: 'full' | 'small';
  /** Copies of sales-q3.csv's rows in the in-memory fixture. */
  readonly memoryRepeats: number;
  readonly workers: readonly number[];
  readonly memorySamples: number;
  readonly diskSequentialSamples: number;
  readonly diskSamples: number;
  readonly startSamples: number;
  /** Bytes of each shape the single-thread overhead is measured on. */
  readonly overheadBytes: number;
  /** Bytes of the run of quotes, the worst case, which is slow to scan. */
  readonly worstBytes: number;
  readonly overheadSamples: number;
  /** Chunk starts probed per shape for where paths merge. */
  readonly probes: number;
}

const FULL: Scale = {
  name: 'full',
  memoryRepeats: 400,
  workers: [1, 2, 4, 8, 12, 15],
  memorySamples: 7,
  diskSequentialSamples: 2,
  diskSamples: 3,
  startSamples: 3,
  overheadBytes: 32 * MB,
  worstBytes: 8 * MB,
  overheadSamples: 5,
  probes: 2000,
};

const SMALL: Scale = {
  name: 'small',
  memoryRepeats: 40,
  workers: [1, 2, 4],
  memorySamples: 2,
  diskSequentialSamples: 1,
  diskSamples: 2,
  startSamples: 2,
  overheadBytes: 8 * MB,
  worstBytes: 2 * MB,
  overheadSamples: 2,
  probes: 200,
};

/** Copies of sales-q3.csv's rows in the small disk file. */
const SMALL_DISK_REPEATS = 100;
/** Bytes per probe chunk: well past where paths merge in real data. */
const PROBE_BYTES = 64 << 10;
/** The most bytes of a shape the probes start in. */
const PROBED_BYTES = 32 * MB;
/** Probe starts are moved by up to this many bytes, a prime, so they land all over the rows. */
const PROBE_JITTER = 13;
const PERCENTILE_99 = 0.99;

/** One timed run: wall time and CPU time, in milliseconds. */
interface Run {
  wallMs: number;
  /** Every thread of the process. */
  cpuMs: number;
  mainCpuMs: number;
  workerCpuMs: number;
}

/** Summary of a configuration's runs. CPU figures are medians. */
interface Summary {
  samples: number;
  minMs: number;
  medianMs: number;
  cpuMs: number;
  mainCpuMs: number;
  workerCpuMs: number;
  /** CPU time over wall time: how many cores were busy, on average. */
  coresBusy: number;
}

function round(value: number): number {
  const scale = 10 ** DIGITS;
  return Math.round(value * scale) / scale;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summarize(runs: readonly Run[]): Summary {
  const wall = runs.map((r) => r.wallMs);
  const cpu = median(runs.map((r) => r.cpuMs));
  const medianMs = median(wall);
  return {
    samples: runs.length,
    minMs: round(Math.min(...wall)),
    medianMs: round(medianMs),
    cpuMs: round(cpu),
    mainCpuMs: round(median(runs.map((r) => r.mainCpuMs))),
    workerCpuMs: round(median(runs.map((r) => r.workerCpuMs))),
    coresBusy: round(cpu / medianMs),
  };
}

/** measure times one run of `fn`, with the CPU of the process, the main thread and the pool. */
async function measure(fn: () => Promise<void>, pool?: ScanPool): Promise<Run> {
  const cpu = process.cpuUsage();
  const main = process.threadCpuUsage();
  const workers = pool?.cpuMicros() ?? 0;
  const started = performance.now();
  await fn();
  const wallMs = performance.now() - started;
  const cpuDone = process.cpuUsage(cpu);
  const mainDone = process.threadCpuUsage(main);
  return {
    wallMs,
    cpuMs: (cpuDone.user + cpuDone.system) / MICROS_PER_MS,
    mainCpuMs: (mainDone.user + mainDone.system) / MICROS_PER_MS,
    workerCpuMs: ((pool?.cpuMicros() ?? 0) - workers) / MICROS_PER_MS,
  };
}

async function repeat(samples: number, fn: () => Promise<Run>): Promise<Run[]> {
  const runs: Run[] = [];
  for (let i = 0; i < samples; i++) runs.push(await fn());
  return runs;
}

function log(message: string): void {
  process.stderr.write(`[parallel] ${message}\n`);
}

/** sequential runs core's indexPass and returns the run and its index. */
async function sequential(
  source: ByteSource,
  format: Format,
): Promise<{ run: Run; index: RowIndex }> {
  const ctx = contextFor(source, format, TUNING);
  const run = await measure(() => indexPass(ctx));
  return { run, index: ctx.index };
}

/** parallel runs the parallel pass on `pool` and checks its index against `want`. */
async function parallel(
  source: ByteSource,
  format: Format,
  pool: ScanPool,
  stitch: StitchMode,
  want: RowIndex,
): Promise<Run> {
  const ctx = contextFor(source, format, TUNING);
  const plan = planFor(pool.size, READS, stitch);
  const run = await measure(() => parallelIndexPass(ctx, pool, plan), pool);
  const differs = difference(ctx.index, want);
  if (differs !== undefined) {
    throw new Error(`${pool.size} workers, ${stitch}: ${differs}`);
  }
  return run;
}

/** formatOf sniffs a source as a .csv. Throws for an empty one. */
async function formatOf(source: ByteSource): Promise<Format> {
  const format = await peekFormat('bench.csv', source);
  if (format === undefined) throw new Error('the fixture read as empty');
  return format;
}

/** Startup is what starting a pool of `workers` cost. */
interface Startup {
  workers: number;
  minMs: number;
  medianMs: number;
}

/** The start-up cost of a pool: spawning its workers until each is ready. */
async function startup(scale: Scale): Promise<Startup[]> {
  const out: Startup[] = [];
  for (const workers of scale.workers) {
    const ms: number[] = [];
    for (let i = 0; i < scale.startSamples; i++) {
      const started = performance.now();
      const pool = await ScanPool.start(workers);
      ms.push(performance.now() - started);
      await pool.close();
    }
    out.push({
      workers,
      minMs: round(Math.min(...ms)),
      medianMs: round(median(ms)),
    });
    log(`start ${workers} workers: ${round(median(ms))} ms`);
  }
  return out;
}

/** chunksOf cuts bytes into the engine's chunks. */
function chunksOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += TUNING.chunkBytes) {
    out.push(
      bytes.subarray(at, Math.min(at + TUNING.chunkBytes, bytes.length)),
    );
  }
  return out;
}

/**
 * Untimed runs of each single-thread method before it is timed: enough calls
 * for V8 to tier the scan loops up to optimized code.
 */
const WARM_UP_RUNS = 3;

/** Room an OffsetList starts with. */
const LIST_CAPACITY = 1 << 16;

/** OffsetList is a growing Float64Array, what the speculative scan writes to. */
class OffsetList {
  buffer = new Float64Array(LIST_CAPACITY);
  length = 0;

  push(offset: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Float64Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length++] = offset;
  }
}

/** A way of scanning a file's chunks on one thread. Returns the records found. */
type Method = (chunks: readonly Uint8Array[]) => number;

const SEP = separatorOf(',');

/**
 * METHODS are what the overhead section times. RecordScanner counting is
 * tests/performance/scan.test.ts; to a list writes what the speculative scan
 * writes; to an index is indexPass without its reads.
 */
const METHODS: ReadonlyArray<readonly [string, Method]> = [
  [
    'recordScannerCounting',
    (chunks) => {
      let records = 0;
      const scanner = new RecordScanner(',', () => records++);
      eachChunk(chunks, (chunk, at) => scanner.push(chunk, at));
      return records;
    },
  ],
  [
    'recordScannerToList',
    (chunks) => {
      const list = new OffsetList();
      const scanner = new RecordScanner(',', (offset) => list.push(offset));
      eachChunk(chunks, (chunk, at) => scanner.push(chunk, at));
      return list.length;
    },
  ],
  [
    'recordScannerToIndex',
    (chunks) => {
      const index = new RowIndex(0, totalOf(chunks), TUNING);
      const scanner = new RecordScanner(',', (offset) => index.begin(offset));
      eachChunk(chunks, (chunk, at) => scanner.push(chunk, at));
      return index.counted;
    },
  ],
  [
    'speculative',
    (chunks) => {
      let state: State = LINE;
      let records = 0;
      eachChunk(chunks, (chunk, at) => {
        const traced = trace(scanChunk(chunk, at, SEP), state);
        for (const [from, to] of traced.ranges) records += to - from;
        state = traced.end;
      });
      return records;
    },
  ],
  [
    'speculativeToIndex',
    (chunks) => {
      const index = new RowIndex(0, totalOf(chunks), TUNING);
      const stitcher = new Stitcher(index, TUNING, 'block', 0);
      eachChunk(chunks, (chunk, at) => stitcher.add(scanChunk(chunk, at, SEP)));
      return index.counted;
    },
  ],
];

function eachChunk(
  chunks: readonly Uint8Array[],
  fn: (chunk: Uint8Array, at: number) => void,
): void {
  let at = 0;
  for (const chunk of chunks) {
    fn(chunk, at);
    at += chunk.length;
  }
}

function totalOf(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

/** A min and median, in milliseconds. */
interface Spread {
  min: number;
  median: number;
}

/** ratio divides one spread by another, min by min and median by median. */
function ratio(a: Spread, b: Spread): Spread {
  return { min: round(a.min / b.min), median: round(a.median / b.median) };
}

/**
 * overheadOf times, on one thread, RecordScanner and the speculative scan
 * over the same chunks of a shape. Each method runs WARM_UP_RUNS times
 * untimed first, so every one is timed after the JIT has optimized it.
 */
async function overheadOf(shape: Shape, size: number, samples: number) {
  const bytes = shape.make(size);
  const chunks = chunksOf(bytes);
  const ms: Record<string, Spread> = {};
  let records: number | undefined;

  for (const [name, method] of METHODS) {
    let found = 0;
    for (let run = 0; run < WARM_UP_RUNS; run++) found = method(chunks);
    if (records !== undefined && found !== records) {
      throw new Error(
        `${shape.name}: ${name} found ${found} records, not ${records}`,
      );
    }
    records = found;
    const runs = await repeat(samples, () =>
      measure(async () => void method(chunks)),
    );
    const summary = summarize(runs);
    ms[name] = { min: summary.minMs, median: summary.medianMs };
  }

  const scans = chunks.map((chunk, k) =>
    scanChunk(chunk, k * TUNING.chunkBytes, SEP),
  );
  const total = scans.reduce((sum, s) => sum + s.begins.length, 0);
  return {
    shape: shape.name,
    bytes: bytes.length,
    records,
    ms,
    speculativeOverRecordScannerToList: ratio(
      ms['speculative']!,
      ms['recordScannerToList']!,
    ),
    speculativeOverRecordScannerCounting: ratio(
      ms['speculative']!,
      ms['recordScannerCounting']!,
    ),
    speculativeToIndexOverRecordScannerToIndex: ratio(
      ms['speculativeToIndex']!,
      ms['recordScannerToIndex']!,
    ),
    /** Begins every path reported, over the records of the true reading. */
    beginsOverRecords: round(total / Math.max(1, records ?? 0)),
    chunks: scans.map((s) => ({
      merged: s.stats.merged,
      survivors: s.stats.survivors,
      stepped: s.stats.stepped,
    })),
  };
}

/** mergeOf probes where paths merge from many chunk starts in `size` bytes of a shape. */
function mergeOf(shape: Shape, probes: number, size: number) {
  const bytes = shape.make(size);
  const stride = Math.floor((bytes.length - PROBE_BYTES) / probes);
  const merged: number[] = [];
  const stepped: number[] = [];
  let never = 0;
  for (let k = 0; k < probes; k++) {
    const at = k * stride + (k % PROBE_JITTER);
    const scan = scanChunk(bytes.subarray(at, at + PROBE_BYTES), at, SEP);
    stepped.push(scan.stats.stepped);
    if (scan.stats.merged === NONE) never++;
    else merged.push(scan.stats.merged);
  }
  return {
    shape: shape.name,
    probes,
    probeBytes: PROBE_BYTES,
    neverMerged: never,
    mergedAtMedian: merged.length > 0 ? median(merged) : null,
    mergedAtP99: merged.length > 0 ? percentile(merged, PERCENTILE_99) : null,
    mergedAtMax: merged.length > 0 ? Math.max(...merged) : null,
    steppedMedian: median(stepped),
    steppedMax: Math.max(...stepped),
  };
}

/** Speedups is sequential time over parallel time. */
interface Speedups {
  speedupMedian: number;
  speedupMin: number;
}

/** speedups compares a parallel summary with the sequential one. */
function speedups(seq: Summary, par: Summary): Speedups {
  return {
    speedupMedian: round(seq.medianMs / par.medianMs),
    speedupMin: round(seq.minMs / par.minMs),
  };
}

/** Entry is one parallel configuration's result. */
interface Entry extends Summary, Speedups {
  workers: number;
  stitch: StitchMode;
  /** The first run on a fresh pool, before the workers' JIT has warmed up. */
  firstRunMs?: number;
  /** Bytes of the file still in the page cache before a cold run. */
  cachedBytesBefore?: number | null;
  /** The index matched the sequential one on every run. */
  identical: true;
}

/** fastest is the entry with the best median speedup. */
function fastest(entries: readonly Entry[]) {
  const best = entries.reduce((a, b) =>
    b.speedupMedian > a.speedupMedian ? b : a,
  );
  const { workers, stitch, medianMs, speedupMedian, coresBusy } = best;
  return { workers, stitch, medianMs, speedupMedian, coresBusy };
}

/** memory indexes the sales fixture held in memory, shared with the workers. */
async function memory(scale: Scale) {
  const fixture = repeated(scale.memoryRepeats);
  const shared = new Uint8Array(new SharedArrayBuffer(fixture.length));
  shared.set(fixture);
  const source = bytesSource(shared);
  const format = await formatOf(source);

  const reference = await sequential(source, format);
  const want = reference.index;
  if (want.counted !== scale.memoryRepeats * ROWS) {
    throw new Error('the sequential pass miscounted the fixture');
  }
  const seq = summarize([
    reference.run,
    ...(await repeat(scale.memorySamples - 1, async () => {
      return (await sequential(source, format)).run;
    })),
  ]);
  log(`memory sequential: ${seq.medianMs} ms`);

  const runs: Entry[] = [];
  for (const workers of scale.workers) {
    const pool = await ScanPool.start(workers);
    try {
      // Timed apart from the samples, as the warm-up of a fresh pool.
      const first = await parallel(source, format, pool, 'block', want);
      for (const stitch of ['block', 'record'] as const) {
        if (stitch !== 'block') {
          await parallel(source, format, pool, stitch, want);
        }
        const par = summarize(
          await repeat(scale.memorySamples, () =>
            parallel(source, format, pool, stitch, want),
          ),
        );
        runs.push({
          workers,
          stitch,
          ...(stitch === 'block' ? { firstRunMs: round(first.wallMs) } : {}),
          ...par,
          ...speedups(seq, par),
          identical: true,
        });
        log(`memory ${workers} workers ${stitch}: ${par.medianMs} ms`);
      }
      if (pool.handoffs.copied > 0)
        throw new Error('a shared chunk was copied');
    } finally {
      await pool.close();
    }
  }
  return {
    bytes: fixture.length,
    rows: want.counted,
    chunkBytes: TUNING.chunkBytes,
    sequential: seq,
    parallel: runs,
  };
}

/** Tries at dropping a file from the page cache, and the wait between them. */
const DROP_TRIES = 10;
const DROP_WAIT_MS = 200;
/**
 * The cached bytes a drop may leave: a few pages the kernel had not yet put
 * on its lists when asked.
 */
const DROP_LEFT_BYTES = 1 * MB;

/**
 * dropCache drops a file's pages from the page cache, trying again while
 * fincore still finds much of it there, and returns the bytes still cached.
 * Pages read moments ago can sit on a per-CPU list the drop skips.
 */
async function dropCache(path: string): Promise<number | null> {
  let left: number | null = null;
  for (let tries = 0; tries < DROP_TRIES; tries++) {
    execFileSync('dd', [
      `if=${path}`,
      'iflag=nocache',
      'count=0',
      'status=none',
    ]);
    left = cachedBytes(path);
    if (left === null || left <= DROP_LEFT_BYTES) return left;
    await sleep(DROP_WAIT_MS);
  }
  return left;
}

/** cachedBytes asks fincore how much of a file is in the page cache, if it can. */
function cachedBytes(path: string): number | null {
  try {
    const out = execFileSync(
      'fincore',
      ['--bytes', '--noheadings', '--output', 'RES', path],
      { encoding: 'utf8' },
    );
    return Number(out.trim());
  } catch {
    return null;
  }
}

/** smallDiskFile writes the small scale's disk file, once. */
function smallDiskFile(): string {
  mkdirSync(LAB_DISK, { recursive: true });
  const path = join(LAB_DISK, `sales-${SMALL_DISK_REPEATS}.csv`);
  if (!existsSync(path)) writeFileSync(path, repeated(SMALL_DISK_REPEATS));
  return path;
}

/** disk indexes a file on disk, warm and then once cold, for each configuration. */
async function disk(scale: Scale, path: string) {
  const source = await nodeSource(path);
  try {
    const format = await formatOf(source);
    // Pull the file into the page cache before the warm runs.
    const warming = contextFor(source, format, TUNING);
    const warmPool = await ScanPool.start(Math.max(...scale.workers));
    await parallelIndexPass(
      warming,
      warmPool,
      planFor(warmPool.size, READS, 'block'),
    );
    await warmPool.close();
    const cachedWarm = cachedBytes(path);

    const reference = await sequential(source, format);
    const want = reference.index;
    const differs = difference(warming.index, want);
    if (differs !== undefined) throw new Error(`warming pass: ${differs}`);
    const seq = summarize([
      reference.run,
      ...(await repeat(scale.diskSequentialSamples - 1, async () => {
        return (await sequential(source, format)).run;
      })),
    ]);
    log(`disk warm sequential: ${seq.medianMs} ms`);

    const cachedCold = await dropCache(path);
    const seqCold = summarize([(await sequential(source, format)).run]);
    log(`disk cold sequential: ${seqCold.medianMs} ms`);

    const warm: Entry[] = [];
    const cold: Entry[] = [];
    for (const workers of scale.workers) {
      const pool = await ScanPool.start(workers);
      try {
        // The first run, on a fresh pool, is one of the samples: on a file
        // this size the JIT's warm-up is lost in it.
        const runs = await repeat(scale.diskSamples, () =>
          parallel(source, format, pool, 'block', want),
        );
        const par = summarize(runs);
        warm.push({
          workers,
          stitch: 'block',
          firstRunMs: round(runs[0]!.wallMs),
          ...par,
          ...speedups(seq, par),
          identical: true,
        });
        log(`disk warm ${workers} workers: ${par.medianMs} ms`);

        const left = await dropCache(path);
        const once = summarize([
          await parallel(source, format, pool, 'block', want),
        ]);
        cold.push({
          workers,
          stitch: 'block',
          cachedBytesBefore: left,
          ...once,
          ...speedups(seqCold, once),
          identical: true,
        });
        log(`disk cold ${workers} workers: ${once.medianMs} ms`);
      } finally {
        await pool.close();
      }
    }

    return {
      path,
      bytes: source.size,
      rows: want.counted,
      reads: READS,
      cachedBytesWarm: cachedWarm,
      warm: { sequential: seq, parallel: warm },
      cold: {
        note: 'one run each, after dd iflag=nocache dropped the file from the page cache',
        sequential: { cachedBytesBefore: cachedCold, ...seqCold },
        parallel: cold,
      },
    };
  } finally {
    await source.close();
  }
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const began = performance.now();
  const scale = process.argv.includes('--small') ? SMALL : FULL;
  const big = scale === SMALL ? smallDiskFile() : (argument('--big') ?? BIG);
  if (!existsSync(big)) throw new Error(`${big} is missing`);
  log(`scale ${scale.name}, disk file ${big} (${statSync(big).size} bytes)`);

  const overhead = [];
  for (const shape of [SALES, SYNTHETIC, PLAIN, ALTERNATING]) {
    overhead.push(
      await overheadOf(shape, scale.overheadBytes, scale.overheadSamples),
    );
    log(`overhead ${shape.name} done`);
  }
  overhead.push(
    await overheadOf(QUOTE_RUN, scale.worstBytes, scale.overheadSamples),
  );
  const merge = [SALES, SYNTHETIC, PLAIN, ALTERNATING].map((shape) =>
    mergeOf(shape, scale.probes, Math.min(scale.overheadBytes, PROBED_BYTES)),
  );

  const starts = await startup(scale);
  const inMemory = await memory(scale);
  const onDisk = await disk(scale, big);
  const blockOnly = (entries: readonly Entry[]) =>
    entries.filter((e) => e.stitch === 'block');

  const result = {
    name: 'parallel',
    scale: scale.name,
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      threads: availableParallelism(),
      node: process.version,
      uvThreadpool: process.env['UV_THREADPOOL_SIZE'] ?? 'default (4)',
    },
    units:
      "ms of wall time; cpuMs is user+system over every thread of the process; workerCpuMs is the workers' threads; mainCpuMs the main thread",
    headline: {
      memory: {
        sequentialMs: inMemory.sequential.medianMs,
        fastest: fastest(blockOnly(inMemory.parallel)),
      },
      diskWarm: {
        sequentialMs: onDisk.warm.sequential.medianMs,
        fastest: fastest(onDisk.warm.parallel),
      },
      diskCold: {
        sequentialMs: onDisk.cold.sequential.medianMs,
        fastest: fastest(onDisk.cold.parallel),
      },
      poolStartMs: starts.map(({ workers, medianMs }) => ({
        workers,
        medianMs,
      })),
      speculativeOverRecordScanner: overhead.map((o) => ({
        shape: o.shape,
        median: o.speculativeOverRecordScannerToList.median,
      })),
    },
    startup: starts,
    overhead,
    merge,
    memory: inMemory,
    disk: onDisk,
    elapsedSeconds: 0,
  };
  result.elapsedSeconds = round((performance.now() - began) / MS_PER_SECOND);

  const json = JSON.stringify(result);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(OUT_FILE, `${json}\n`);
  log(`wrote ${OUT_FILE} after ${result.elapsedSeconds} s`);
  process.stdout.write(`${json}\n`);
}

await main();
