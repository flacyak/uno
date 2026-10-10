/**
 * @fileoverview What giving the engine more memory buys. One command measures:
 *
 * (a) heap bytes per source byte held in the page cache, per row shape;
 * (b) Format.decode throughput, and the share of it spent decoding text;
 * (c) a person's session through the real engine, once per cacheBytes
 *     variant, over a large file on disk: jumps to random places reading a
 *     band of BAND_ROWS rows each, then two passes back over them in shuffled
 *     orders. Per-jump milliseconds for first visits and revisits, and the hit
 *     rate. Run with the file's pages in the kernel's cache ("disk"), and at
 *     TUNING's own cacheBytes with them dropped first ("cold");
 * (d) the same session with 50 ms slept before every read ("slowed"), as the
 *     harness's slowed provider does, standing in for a bucket. Every variant
 *     runs at once, one process each, since these sessions mostly sleep;
 * (e) a find to the end of a file under each variant, with the bytes it read
 *     and whether the cache kept a session's blocks through it;
 * (f) the heap limit, and a page cache filled level by level in a process of
 *     its own, up to a budget past what the heap limit allows: heap and
 *     collector pauses at each level, and how the process ends.
 *
 * Every variant replays the same jumps in the same orders, so hit rates
 * differ by cacheBytes alone.
 *
 * Run from core/, alone on the machine:
 *   node --import ../paths.js \
 *     tests/lab/cache/cache.bench.ts [--scale=small] [--dir=<folder>]
 *
 * --dir is where the large files are written, once, and reused: by default
 * /home/hech/.cache/uno-lab/cache, on the NVMe disk, since /tmp is RAM here.
 * The last line on stdout is the JSON result, also written to
 * core/out/lab/cache.json. Progress goes to stderr.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

import { BAND_ROWS, ROWS_AT_MOST, TUNING } from '@engine';
import type { SourceHandle } from '@engine';
import { diskProvider, nodeSource } from '@store/node';
import { connect, indexed, openOne } from '@core-tests/engine/harness';
import { onLines, start, stderrOf } from './child.ts';
import type { FillLine } from './fill.ts';
import { bandCost, decodeTimes, heapPerSourceByte } from './heap.ts';
import type { HeapReading } from './heap.ts';
import { collector, heapUsed, layoutOf } from './layout.ts';
import type { Layout } from './layout.ts';
import {
  SEED,
  dropCached,
  findToEnd,
  hitRate,
  opened,
  orderFor,
  pickJumps,
  runSessions,
  visit,
} from './session.ts';
import type { FindRun, Jump, SessionRun, Visit } from './session.ts';
import { fileName, shapeBytes, writeShape } from './shapes.ts';
import type { ShapeName } from './shapes.ts';
import { GO } from './slowed.ts';
import type { SlowedAsk, SlowedLine } from './slowed.ts';
import {
  median,
  min,
  rounded,
  roundedSpread,
  seeded,
  shuffled,
  spread,
} from './stats.ts';
import type { Spread } from './stats.ts';
import { Watch } from './watch.ts';

/** Bytes in a megabyte. */
const MB = 1 << 20;
/** Bytes in a gigabyte. */
const GB = 1 << 30;
/** Milliseconds in a second. */
const SECOND_MS = 1000;

/** The cacheBytes variants, in MB. 32 is TUNING's own. */
const CACHE_MB: readonly number[] = [8, 32, 128, 512];
/** The variant the cold sessions run under: TUNING's own. */
const COLD_CACHE_MB = TUNING.cacheBytes / MB;
/** What the slowed provider sleeps before each read, as a bucket's latency. */
const SLOW_MS = 50;

/** Shapes the heap and decode measures cover. */
const MEASURED_SHAPES: readonly ShapeName[] = ['sales', 'synthetic', 'wide'];
/** Shapes the sessions run over, each in a file of its own. */
const SESSION_SHAPES: readonly ShapeName[] = ['sales', 'wide'];
/** The shape of the file the finds run over. */
const FIND_SHAPE: ShapeName = 'sales';

/** Scale is how much of everything one run does. */
interface Scale {
  /** Bytes of each disk file the sessions run over. */
  fileBytes: number;
  /** Bytes of the file the finds run over. */
  findFileBytes: number;
  /** Bytes of each in-memory sample the heap and decode measures use. */
  sampleBytes: number;
  /** Places one session jumps to. */
  jumps: number;
  /** Sessions per variant with the file's pages cached by the kernel. */
  diskSessions: number;
  /** Sessions at COLD_CACHE_MB with the file's pages dropped first. */
  coldSessions: number;
  /** Sessions per variant with SLOW_MS before every read. */
  slowedSessions: number;
  /** Finds per variant. */
  finds: number;
  /** Fills of a page cache per shape, for the heap ratio. */
  heapSamples: number;
  /** Passes of decoding per shape. */
  decodeSamples: number;
  /** The levels the fill process stops at, in MB of source. */
  fillLevelsMB: number[];
  /**
   * The heap limit the fill process is given, in MB, or undefined for
   * node's own. The full scale fills under node's own limit until the heap
   * gives out; the small one reaches a small limit the same way, sooner.
   */
  fillHeapLimitMB?: number;
}

type ScaleName = 'full' | 'small';

const SCALES: Record<ScaleName, Scale> = {
  full: {
    fileBytes: GB,
    findFileBytes: 32 * MB,
    sampleBytes: 16 * MB,
    jumps: 30,
    diskSessions: 3,
    coldSessions: 3,
    slowedSessions: 3,
    finds: 2,
    heapSamples: 2,
    decodeSamples: 3,
    fillLevelsMB: [32, 128, 256, 512],
  },
  small: {
    fileBytes: 128 * MB,
    findFileBytes: 8 * MB,
    sampleBytes: 4 * MB,
    jumps: 5,
    diskSessions: 2,
    coldSessions: 2,
    slowedSessions: 2,
    finds: 2,
    heapSamples: 2,
    decodeSamples: 2,
    fillLevelsMB: [8, 32, 64],
    fillHeapLimitMB: 256,
  },
};

const DEFAULT_DIR = '/home/hech/.cache/uno-lab/cache';
/** Where the JSON result is written: core/out/lab/. */
const OUT = fileURLToPath(new URL('../../../out/lab/', import.meta.url));

const began = performance.now();

/** log writes progress to stderr with the seconds since the start. */
function log(what: string): void {
  const s = ((performance.now() - began) / SECOND_MS).toFixed(1);
  process.stderr.write(`[cache ${s}s] ${what}\n`);
}

/** The value of a `--name=value` argument, or undefined. */
function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function isScale(name: string): name is ScaleName {
  return name in SCALES;
}

// ------------------------------------------------------------ (a) and (b)

async function measureHeap(
  scale: Scale,
  gc: () => void,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const shape of MEASURED_SHAPES) {
    const bytes = shapeBytes(shape, scale.sampleBytes);
    const readings: HeapReading[] = [];
    for (let s = 0; s < scale.heapSamples; s++) {
      readings.push(
        await heapPerSourceByte(`${shape}.csv`, bytes, scale.sampleBytes, gc),
      );
    }
    const last = readings.at(-1)!;
    const heap = median(readings.map((r) => r.heapBytes));
    out[shape] = {
      heapPerSourceByte: roundedSpread(spread(readings.map((r) => r.ratio))),
      textHeapPerSourceByte: roundedSpread(
        spread(readings.map((r) => r.textRatio)),
      ),
      heldMB: rounded(last.heldBytes / MB),
      sourceBytesPerRow: rounded(last.heldBytes / last.rows),
      fieldsPerRow: rounded(last.fields / last.rows),
      heapBytesPerRow: rounded(heap / last.rows),
      heapBytesPerField: rounded(heap / last.fields),
    };
    log(`heap ${shape}: ${JSON.stringify(out[shape])}`);
  }
  return out;
}

/** MB per second for some bytes over some milliseconds. */
function mbPerS(bytes: number, ms: number): number {
  return rounded(bytes / MB / (ms / SECOND_MS));
}

async function measureDecode(
  scale: Scale,
  gc: () => void,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const shape of MEASURED_SHAPES) {
    const bytes = shapeBytes(shape, scale.sampleBytes);
    const runs = await decodeTimes(
      `${shape}.csv`,
      bytes,
      scale.decodeSamples,
      gc,
    );
    const size = runs[0]!.bytes;
    const decode = runs.map((r) => r.decodeMs);
    out[shape] = {
      mb: rounded(size / MB),
      decodeMs: roundedSpread(spread(decode)),
      // From the fastest run, and from the median one.
      decodeMBps: {
        fastest: mbPerS(size, min(decode)),
        median: mbPerS(size, median(decode)),
      },
      textMBps: mbPerS(size, min(runs.map((r) => r.textMs))),
      // The share of decode time the TextDecoder step takes. readAll is the rest.
      textShare: rounded(median(runs.map((r) => r.textMs / r.decodeMs))),
    };
    log(`decode ${shape}: ${JSON.stringify(out[shape])}`);
  }
  return out;
}

// ------------------------------------------------------------ (c) and (e)

/** Plan is the jumps every variant of one shape replays. */
interface Plan {
  disk: Jump[][];
  cold: Jump[][];
  slowed: Jump[][];
}

/** planFor picks every session's jumps for one file, none sharing a block. */
function planFor(layout: Layout, scale: Scale): Plan {
  const random = seeded(SEED);
  const taken = opened(layout);
  const sessions = (n: number): Jump[][] =>
    Array.from({ length: n }, () =>
      pickJumps(layout, scale.jumps, random, taken),
    );
  return {
    disk: sessions(scale.diskSessions),
    cold: sessions(scale.coldSessions),
    slowed: sessions(scale.slowedSessions),
  };
}

/** ModeSummary is one kind of session under one variant. */
interface ModeSummary {
  sessions: number;
  /** Over sessions, each session's median ms per first visit. */
  firstJumpMs: Spread;
  /** Over sessions, each session's median ms per revisit. */
  revisitJumpMs: Spread;
  /** Over sessions, each session's mean ms per revisit. */
  revisitMeanJumpMs: Spread;
  /** Over sessions, the share of revisit block lookups the cache answered. */
  revisitHitRate: Spread;
  /** Blocks read per first visit, over every session. */
  firstMissesPerJump: number;
  /** Blocks spanned per first visit. Equal to firstMissesPerJump when every
   * first visit missed, as the plan intends. */
  firstBlocksPerJump: number;
  /** Median ms of the revisits that read nothing, or null when none did. */
  allHitJumpMs: number | null;
  /** Median ms of the revisits that read every block, or null when none did. */
  allMissJumpMs: number | null;
}

/** The median ms of some visits, or null for none. */
function medianMs(visits: readonly Visit[]): number | null {
  return visits.length === 0 ? null : rounded(median(visits.map((v) => v.ms)));
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function summarize(runs: readonly SessionRun[]): ModeSummary {
  const firsts = runs.flatMap((r) => r.first);
  const revisits = runs.flatMap((r) => r.revisits);
  return {
    sessions: runs.length,
    firstJumpMs: roundedSpread(
      spread(runs.map((r) => median(r.first.map((v) => v.ms)))),
    ),
    revisitJumpMs: roundedSpread(
      spread(runs.map((r) => median(r.revisits.map((v) => v.ms)))),
    ),
    revisitMeanJumpMs: roundedSpread(
      spread(runs.map((r) => mean(r.revisits.map((v) => v.ms)))),
    ),
    revisitHitRate: roundedSpread(spread(runs.map((r) => hitRate(r.revisits)))),
    firstMissesPerJump: rounded(mean(firsts.map((v) => v.misses))),
    firstBlocksPerJump: rounded(mean(firsts.map((v) => v.blocks))),
    allHitJumpMs: medianMs(revisits.filter((v) => v.misses === 0)),
    allMissJumpMs: medianMs(revisits.filter((v) => v.misses === v.blocks)),
  };
}

/** EngineRun is what one cacheBytes variant measured over one file. */
interface EngineRun {
  shape: ShapeName;
  cacheMB: number;
  indexMs: number;
  /** Heap the engine gained over the disk sessions, after a collection. */
  heapForSessionsMB: number;
  disk: ModeSummary;
  cold: ModeSummary | null;
  slowed?: ModeSummary;
}

/**
 * openIndexed connects an engine at `cacheMB` through a Watch and opens and
 * indexes `path`. Throws if the engine counts other rows than `layout`.
 */
async function openIndexed(
  shape: ShapeName,
  path: string,
  layout: Layout,
  cacheMB: number,
): Promise<{
  watch: Watch;
  src: SourceHandle;
  done: () => void;
  indexMs: number;
}> {
  const watch = new Watch(diskProvider());
  const { engine, done } = connect({ ...TUNING, cacheBytes: cacheMB * MB }, [
    watch.provider,
  ]);
  try {
    const opening = performance.now();
    const src = await openOne(engine, { name: `${shape}.csv`, path });
    await indexed(src);
    const indexMs = performance.now() - opening;
    if (src.progress.rows !== layout.index.counted) {
      throw new Error(
        `${shape}: the engine counted ${src.progress.rows} rows, the layout ${layout.index.counted}`,
      );
    }
    return { watch, src, done, indexMs };
  } catch (err) {
    done();
    throw err;
  }
}

async function engineRun(
  shape: ShapeName,
  path: string,
  layout: Layout,
  plan: Plan,
  cacheMB: number,
  gc: () => void,
): Promise<EngineRun> {
  const { watch, src, done, indexMs } = await openIndexed(
    shape,
    path,
    layout,
    cacheMB,
  );
  try {
    gc();
    const heapBefore = heapUsed();
    const disk = await runSessions(src, watch, plan.disk);
    gc();
    const heapForSessions = heapUsed() - heapBefore;

    let cold: ModeSummary | null = null;
    if (cacheMB === COLD_CACHE_MB) {
      let dropped = true;
      const runs = await runSessions(src, watch, plan.cold, () => {
        dropped = dropCached(path) && dropped;
      });
      cold = dropped ? summarize(runs) : null;
    }
    const run: EngineRun = {
      shape,
      cacheMB,
      indexMs: rounded(indexMs),
      heapForSessionsMB: rounded(heapForSessions / MB),
      disk: summarize(disk),
      cold,
    };
    log(`session ${shape} ${cacheMB} MB: ${JSON.stringify(run)}`);
    return run;
  } finally {
    done();
  }
}

/** FindSummary is the finds to the end of the file under one variant. */
interface FindSummary {
  cacheMB: number;
  finds: number;
  ms: Spread;
  /** The median find's time, scaled to a 1 GB file. */
  msPerGB: number;
  /** Bytes each find read over the file's size, first find to last. */
  bytesReadOverFile: number[];
  searched: number;
  complete: boolean;
  /** A session's jumps, revisited after the finds. 1 means none was evicted. */
  revisitHitRateAfterFinds: number;
}

/**
 * findRun opens the find file at `cacheMB`, runs one disk session so the cache
 * holds its blocks, finds to the end of the file `finds` times, then revisits
 * the session's jumps.
 */
async function findRun(
  path: string,
  layout: Layout,
  jumps: readonly Jump[],
  cacheMB: number,
  finds: number,
): Promise<FindSummary> {
  const { watch, src, done } = await openIndexed(
    FIND_SHAPE,
    path,
    layout,
    cacheMB,
  );
  try {
    await runSessions(src, watch, [jumps]);
    const runs: FindRun[] = [];
    for (let i = 0; i < finds; i++) runs.push(await findToEnd(src, watch));
    const after: Visit[] = [];
    for (const jump of shuffled(jumps, orderFor(0))) {
      after.push(await visit(src, watch, jump));
    }
    const ms = runs.map((r) => r.ms);
    const summary: FindSummary = {
      cacheMB,
      finds,
      ms: roundedSpread(spread(ms)),
      msPerGB: rounded((median(ms) * GB) / layout.index.size),
      bytesReadOverFile: runs.map((r) => rounded(r.bytes / layout.index.size)),
      searched: runs[0]!.found.searched,
      complete: runs.every((r) => r.found.complete && r.found.row === null),
      revisitHitRateAfterFinds: rounded(hitRate(after)),
    };
    log(`find ${cacheMB} MB: ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    done();
  }
}

/** Every jump of a plan. */
function planned(plan: Plan): Jump[] {
  return [...plan.disk, ...plan.cold, ...plan.slowed].flat();
}

/** What a band costs in one file, over some jumps picked in it. */
function bandFacts(
  layout: Layout,
  jumps: readonly Jump[],
): Record<string, number> {
  const costs = jumps.map((j) => bandCost(layout, j.from, BAND_ROWS));
  const blocks = mean(costs.map((c) => c.blocks));
  const bytes = mean(costs.map((c) => c.bytes));
  return {
    fileMB: rounded(layout.index.size / MB),
    rows: layout.index.counted,
    blocks: layout.blocks,
    blockKB: rounded(layout.index.size / layout.blocks / (1 << 10)),
    blocksPerBand: rounded(blocks),
    bandSourceMB: rounded(bytes / MB),
  };
}

// ------------------------------------------------------------ (d)

/** One variant's slowed sessions, as its process reported them. */
interface SlowedVariant {
  shape: ShapeName;
  cacheMB: number;
  runs: SessionRun[];
}

/**
 * slowedAll runs every variant's slowed sessions at once, one process each.
 * The sessions start together, once every process has indexed its file.
 */
async function slowedAll(
  asks: readonly { shape: ShapeName; ask: SlowedAsk }[],
): Promise<SlowedVariant[]> {
  const children = asks.map(({ shape, ask }) => {
    const child = start('slowed.ts', []);
    const tail = stderrOf(child);
    let resolveReady = (): void => {};
    const ready = new Promise<void>((resolve) => (resolveReady = resolve));
    const runs = new Promise<SessionRun[]>((resolve, reject) => {
      onLines<SlowedLine>(child, (line) => {
        if (line.t === 'ready') resolveReady();
        else resolve(line.runs);
      });
      child.on('close', (code) =>
        reject(
          new Error(
            `slowed ${shape} ${ask.cacheMB} MB exited ${code}: ${tail()}`,
          ),
        ),
      );
    });
    // A process that dies before it is ready fails the wait for it.
    const readyOrDead = Promise.race([ready, runs.then(() => undefined)]);
    child.stdin.write(`${JSON.stringify(ask)}\n`);
    return { shape, ask, child, readyOrDead, runs };
  });
  await Promise.all(children.map((c) => c.readyOrDead));
  log(`slowed: ${children.length} processes indexed, sessions start`);
  for (const c of children) c.child.stdin.end(`${GO}\n`);
  return Promise.all(
    children.map(async (c) => ({
      shape: c.shape,
      cacheMB: c.ask.cacheMB,
      runs: await c.runs,
    })),
  );
}

// ------------------------------------------------------------ (f)

/** FillRun is how one fill process went. */
interface FillRun {
  heapLimitFlagMB: number | null;
  exitCode: number | null;
  signal: string | null;
  heapSizeLimitMB: number | null;
  levels: Extract<FillLine, { t: 'level' }>[];
  /** A progress line every TRACE_BYTES, to show the fill slow near the limit. */
  trace: Progress[];
  /** The last progress line, which is where a killed process got to. */
  lastProgress: Progress | null;
  outOfMemory: boolean;
  /** Whether the bench killed the process for running past FILL_TIMEOUT_MS. */
  timedOut: boolean;
  ms: number;
}

type Progress = Extract<FillLine, { t: 'progress' }>;

/**
 * How long a fill process may run. A heap close to its limit can spend its
 * time collecting; past this it is killed and reported as timed out.
 */
const FILL_TIMEOUT_MS = 90_000;
/** Source bytes between the progress lines kept in a FillRun's trace. */
const TRACE_BYTES = 32 * MB;

/** traced keeps the first progress line past each multiple of TRACE_BYTES. */
function traced(progress: readonly Progress[]): Progress[] {
  const out: Progress[] = [];
  let next = TRACE_BYTES;
  for (const p of progress) {
    if (p.heldBytes < next) continue;
    out.push(p);
    next = (Math.floor(p.heldBytes / TRACE_BYTES) + 1) * TRACE_BYTES;
  }
  return out;
}

/** fill runs fill.ts over `file` in a process of its own and reads its lines. */
function fill(
  file: string,
  levelsMB: readonly number[],
  heapLimitMB?: number,
): Promise<FillRun> {
  const started = performance.now();
  const child = start('fill.ts', [file, ...levelsMB.map(String)], heapLimitMB);
  const tail = stderrOf(child);
  const lines: FillLine[] = [];
  onLines<FillLine>(child, (line) => lines.push(line));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, FILL_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const levels = lines.filter(
        (l): l is Extract<FillLine, { t: 'level' }> => l.t === 'level',
      );
      const progress = lines.filter((l): l is Progress => l.t === 'progress');
      const limit = lines.find(
        (l): l is Extract<FillLine, { t: 'limit' }> => l.t === 'limit',
      );
      resolve({
        heapLimitFlagMB: heapLimitMB ?? null,
        exitCode,
        signal,
        heapSizeLimitMB:
          limit === undefined ? null : rounded(limit.heapSizeLimit / MB),
        levels,
        trace: traced(progress),
        lastProgress: progress.at(-1) ?? null,
        outOfMemory: /heap out of memory|Reached heap limit/.test(tail()),
        timedOut,
        ms: rounded(performance.now() - started),
      });
    });
  });
}

// ------------------------------------------------------------ main

/** A file of one shape written to `dir`, and its layout. */
async function prepared(
  shape: ShapeName,
  dir: string,
  bytes: number,
): Promise<{ path: string; layout: Layout }> {
  const path = join(dir, fileName(shape, bytes));
  writeShape(shape, path, bytes);
  const source = await nodeSource(path);
  try {
    return { path, layout: await layoutOf(`${shape}.csv`, source) };
  } finally {
    await source.close();
  }
}

async function main(): Promise<void> {
  const scaleName = argument('scale') ?? 'full';
  if (!isScale(scaleName)) throw new Error(`no scale named ${scaleName}`);
  const scale = SCALES[scaleName];
  const dir = argument('dir') ?? DEFAULT_DIR;
  mkdirSync(dir, { recursive: true });
  const gc = collector();

  const variables = process.config.variables as Record<string, unknown>;
  const machine = {
    node: process.version,
    totalMemMB: Math.round(totalmem() / MB),
    heapSizeLimitMB: rounded(v8.getHeapStatistics().heap_size_limit / MB),
    pointerCompression: variables['v8_enable_pointer_compression'] ?? null,
  };
  log(`scale ${scaleName}, files in ${dir}, ${JSON.stringify(machine)}`);

  const heap = await measureHeap(scale, gc);
  const decode = await measureDecode(scale, gc);

  /** Band facts per session shape, and for the find file as `find`. */
  const files: Record<string, Record<string, number>> = {};
  const runs: EngineRun[] = [];
  const asks: { shape: ShapeName; ask: SlowedAsk }[] = [];
  let salesPath = '';
  for (const shape of SESSION_SHAPES) {
    const { path, layout } = await prepared(shape, dir, scale.fileBytes);
    if (shape === 'sales') salesPath = path;
    const plan = planFor(layout, scale);
    files[shape] = bandFacts(layout, planned(plan));
    log(`file ${shape}: ${JSON.stringify(files[shape])}`);
    for (const cacheMB of CACHE_MB) {
      runs.push(await engineRun(shape, path, layout, plan, cacheMB, gc));
      asks.push({
        shape,
        ask: {
          name: `${shape}.csv`,
          path,
          rows: layout.index.counted,
          cacheMB,
          slowMs: SLOW_MS,
          sessions: plan.slowed,
        },
      });
    }
  }

  const finding = await prepared(FIND_SHAPE, dir, scale.findFileBytes);
  // One session's jumps, so the cache holds something for a find to pass.
  const findJumps = pickJumps(
    finding.layout,
    scale.jumps,
    seeded(SEED),
    opened(finding.layout),
  );
  files.find = bandFacts(finding.layout, findJumps);
  const finds: FindSummary[] = [];
  for (const cacheMB of CACHE_MB) {
    finds.push(
      await findRun(
        finding.path,
        finding.layout,
        findJumps,
        cacheMB,
        scale.finds,
      ),
    );
  }

  for (const variant of await slowedAll(asks)) {
    const run = runs.find(
      (r) => r.shape === variant.shape && r.cacheMB === variant.cacheMB,
    )!;
    run.slowed = summarize(variant.runs);
    log(
      `slowed ${variant.shape} ${variant.cacheMB} MB: ${JSON.stringify(run.slowed)}`,
    );
  }

  log(`fill to ${scale.fillLevelsMB.join(', ')} MB`);
  const filled = await fill(
    salesPath,
    scale.fillLevelsMB,
    scale.fillHeapLimitMB,
  );
  log(`fill: ${JSON.stringify(filled)}`);

  const result = {
    name: 'cache',
    scale: scaleName,
    seconds: rounded((performance.now() - began) / SECOND_MS),
    machine,
    tuning: TUNING,
    bandRows: BAND_ROWS,
    rowsAtMost: ROWS_AT_MOST,
    slowMs: SLOW_MS,
    cacheMB: CACHE_MB,
    heap,
    decode,
    files,
    runs,
    finds,
    fill: filled,
  };
  const line = JSON.stringify(result);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'cache.json'), `${line}\n`);
  process.stdout.write(`${line}\n`);
}

if (import.meta.main) await main();
