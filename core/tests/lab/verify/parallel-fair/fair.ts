/**
 * @fileoverview A fairer split of the parallel lab's speedup, for the parent
 * to run alone on a quiet machine. It separates what the parallel pass gets
 * besides workers:
 *
 * - reads in flight: core's indexPass over readAhead(nodeSource), the
 *   read-ahead core already ships for S3 (src/store/ahead.ts);
 * - block stitching: the parallel pass with "record" stitching on disk;
 * - a SharedArrayBuffer source: the in-memory fixture on a plain buffer,
 *   whose chunks the pool must copy;
 * - pool start: a fresh pool's start plus its first pass.
 *
 * Run from core/:
 *
 *   node --import ../paths.js \
 *     tests/lab/verify/parallel-fair/fair.ts [PATH] [--samples N] [--small]
 *     [--reads N]
 *
 * More than 4 reads in flight need UV_THREADPOOL_SIZE raised to match.
 *
 * Configurations take turns within each round, so drift spreads over all of
 * them. Every cold sample is preceded by a page cache drop that fincore
 * checks. Every index is checked against core's indexPass.
 */

import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { RowIndex, TUNING, indexPass } from '@engine';
import { peekFormat } from '@ingest';
import type { Format } from '@ingest';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { AHEAD, readAhead } from '@store/ahead';
import { nodeSource } from '@store/node';
import { repeated } from '@core-tests/testdata/sales-q3';
import { contextFor, difference } from '../../parallel/indexes.ts';
import { parallelIndexPass, planFor } from '../../parallel/pass.ts';
import { ScanPool } from '../../parallel/pool.ts';
import type { StitchMode } from '../../parallel/stitch.ts';

const DEFAULT_PATH = '/home/hech/.cache/uno-lab/sales-q3-50m.csv';
/** Reads in flight, as the parallel bench runs it. `--reads N` changes it. */
const DEFAULT_READS = 4;
let reads = DEFAULT_READS;
const DEFAULT_SAMPLES = 3;
const WIDTHS = [1, 4, 8, 12] as const;
const SMALL_WIDTHS = [1, 2] as const;
/** 96 MB, as in the parallel bench. */
const MEMORY_REPEATS = 400;
const SMALL_MEMORY_REPEATS = 20;
const MEMORY_SAMPLES = 7;
const MICROS_PER_MS = 1000;
const MB = 1 << 20;
const DROP_TRIES = 10;
const DROP_WAIT_MS = 200;
const DROP_LEFT_BYTES = MB;

interface Sample {
  wallMs: number;
  cpuMs: number;
}

interface Config {
  readonly name: string;
  /** Runs one pass and returns its index. The pool, if any, is already up. */
  readonly run: () => Promise<RowIndex>;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round = (x: number): number => Math.round(x * 10) / 10;

async function timed(fn: () => Promise<RowIndex>): Promise<{
  sample: Sample;
  index: RowIndex;
}> {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const index = await fn();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  return {
    sample: { wallMs, cpuMs: (used.user + used.system) / MICROS_PER_MS },
    index,
  };
}

function cachedBytes(path: string): number {
  const out = execFileSync(
    'fincore',
    ['--bytes', '--noheadings', '--output', 'RES', path],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

async function dropCache(path: string): Promise<number> {
  let left = Infinity;
  for (let tries = 0; tries < DROP_TRIES; tries++) {
    execFileSync('dd', [
      `if=${path}`,
      'iflag=nocache',
      'count=0',
      'status=none',
    ]);
    left = cachedBytes(path);
    if (left <= DROP_LEFT_BYTES) return left;
    await sleep(DROP_WAIT_MS);
  }
  throw new Error(`${left} bytes of ${path} stayed cached`);
}

function warmCache(path: string): void {
  execFileSync('cat', [path], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function formatOf(source: ByteSource): Promise<Format> {
  const format = await peekFormat('fair.csv', source);
  if (format === undefined) throw new Error('the file read as empty');
  return format;
}

/** aheadOf wraps a source in core's read-ahead, as S3 sources are. */
function aheadOf(source: ByteSource): ByteSource {
  return {
    size: source.size,
    read: readAhead((at, n) => source.read(at, n), source.size, AHEAD),
    close: () => source.close(),
  };
}

function sequentialConfig(
  name: string,
  source: ByteSource,
  format: Format,
): Config {
  return {
    name,
    run: async () => {
      const ctx = contextFor(source, format, TUNING);
      await indexPass(ctx);
      return ctx.index;
    },
  };
}

function parallelConfig(
  source: ByteSource,
  format: Format,
  pool: ScanPool,
  stitch: StitchMode,
): Config {
  return {
    name: `parallel ${pool.size} ${stitch}`,
    run: async () => {
      const ctx = contextFor(source, format, TUNING);
      await parallelIndexPass(ctx, pool, planFor(pool.size, reads, stitch));
      return ctx.index;
    },
  };
}

interface Row {
  name: string;
  samples: number;
  medianMs: number;
  minMs: number;
  cpuMs: number;
}

/**
 * rounds runs every config once per round, `samples` rounds, calling
 * `before` ahead of each run, and checks each index against `want`.
 */
async function rounds(
  configs: readonly Config[],
  samples: number,
  want: RowIndex,
  before: () => Promise<void>,
): Promise<Row[]> {
  const got = new Map<string, Sample[]>();
  for (let turn = 0; turn < samples; turn++) {
    for (const config of configs) {
      await before();
      const { sample, index } = await timed(() => config.run());
      const differs = difference(index, want);
      if (differs !== undefined) throw new Error(`${config.name}: ${differs}`);
      got.set(config.name, [...(got.get(config.name) ?? []), sample]);
      process.stderr.write(
        `[fair] ${config.name}: ${round(sample.wallMs)} ms\n`,
      );
    }
  }
  return configs.map((config) => {
    const runs = got.get(config.name)!;
    return {
      name: config.name,
      samples: runs.length,
      medianMs: round(median(runs.map((r) => r.wallMs))),
      minMs: round(Math.min(...runs.map((r) => r.wallMs))),
      cpuMs: round(median(runs.map((r) => r.cpuMs))),
    };
  });
}

/** freshPool times a pool's start and its first pass, which is cold JIT. */
async function freshPool(
  width: number,
  source: ByteSource,
  format: Format,
  want: RowIndex,
): Promise<{ width: number; startMs: number; firstPassMs: number }> {
  const started = performance.now();
  const pool = await ScanPool.start(width);
  const startMs = performance.now() - started;
  try {
    const { sample, index } = await timed(() =>
      parallelConfig(source, format, pool, 'block').run(),
    );
    const differs = difference(index, want);
    if (differs !== undefined) throw new Error(`fresh ${width}: ${differs}`);
    return {
      width,
      startMs: round(startMs),
      firstPassMs: round(sample.wallMs),
    };
  } finally {
    await pool.close();
  }
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function disk(path: string, widths: readonly number[], samples: number) {
  const plain = await nodeSource(path);
  const ahead = aheadOf(await nodeSource(path));
  const pools = await Promise.all(widths.map((w) => ScanPool.start(w)));
  try {
    const format = await formatOf(plain);
    warmCache(path);
    const want = await sequentialConfig('ref', plain, format).run();
    const configs: Config[] = [
      sequentialConfig('indexPass', plain, format),
      sequentialConfig('indexPass + readAhead', ahead, format),
    ];
    for (const pool of pools) {
      configs.push(parallelConfig(plain, format, pool, 'block'));
      if (pool.size >= 4) {
        configs.push(parallelConfig(plain, format, pool, 'record'));
      }
    }
    // A pass of each before timing, so every config runs with its JIT warm.
    for (const config of configs) await config.run();
    const warm = await rounds(configs, samples, want, async () => {
      warmCache(path);
    });
    const cold = await rounds(configs, samples, want, async () => {
      await dropCache(path);
    });
    warmCache(path);
    const fresh = [];
    for (const width of widths) {
      fresh.push(await freshPool(width, plain, format, want));
    }
    return { path, bytes: plain.size, warm, cold, fresh };
  } finally {
    await Promise.all(pools.map((pool) => pool.close()));
    await plain.close();
    await ahead.close();
  }
}

async function memory(repeats: number, widths: readonly number[]) {
  const bytes = repeated(repeats);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
  shared.set(bytes);
  const plain = bytesSource(bytes);
  const onShared = bytesSource(shared);
  const format = await formatOf(plain);
  const want = await sequentialConfig('ref', plain, format).run();
  const pools = await Promise.all(widths.map((w) => ScanPool.start(w)));
  try {
    const configs: Config[] = [
      sequentialConfig('indexPass, plain buffer', plain, format),
      sequentialConfig('indexPass, shared buffer', onShared, format),
    ];
    for (const pool of pools) {
      const copied = parallelConfig(plain, format, pool, 'block');
      configs.push({ name: `${copied.name}, plain (copied)`, run: copied.run });
      const sharedRun = parallelConfig(onShared, format, pool, 'block');
      configs.push({
        name: `${sharedRun.name}, shared`,
        run: sharedRun.run,
      });
    }
    for (const config of configs) await config.run();
    return await rounds(configs, MEMORY_SAMPLES, want, async () => undefined);
  } finally {
    await Promise.all(pools.map((pool) => pool.close()));
  }
}

async function main(): Promise<void> {
  const small = process.argv.includes('--small');
  const positional = process.argv[2];
  const path =
    positional !== undefined && !positional.startsWith('--')
      ? positional
      : DEFAULT_PATH;
  const samples = Number(option('--samples') ?? DEFAULT_SAMPLES);
  reads = Number(option('--reads') ?? DEFAULT_READS);
  const widths = small ? SMALL_WIDTHS : WIDTHS;
  const inMemory = await memory(
    small ? SMALL_MEMORY_REPEATS : MEMORY_REPEATS,
    widths,
  );
  const onDisk = await disk(path, widths, samples);
  process.stdout.write(
    `${JSON.stringify({ memory: inMemory, disk: onDisk }, null, 1)}\n`,
  );
}

await main();
