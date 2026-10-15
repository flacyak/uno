/**
 * @fileoverview Peak resident memory of one index pass over a file on disk:
 * core's indexPass, then the parallel pass at several worker counts.
 *
 * Run from core/:
 *
 *   node --import ../paths.js \
 *     tests/lab/verify/parallel-fair/memory.ts PATH WIDTH
 *
 * WIDTH 0 runs core's indexPass; any other runs the parallel pass on that
 * many workers. Run each width in a fresh process: glibc keeps freed 8 MB
 * chunks, so a second pass in one process starts from a raised floor.
 *
 * The kernel's high-water mark (VmHWM) is reset through /proc/self/clear_refs
 * after the pool has started, so the peak is the pass's own on top of the
 * process and its idle workers. Timings are printed only as a hint.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { TUNING, indexPass } from '@engine';
import { peekFormat } from '@ingest';
import type { Format } from '@ingest';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';
import { contextFor, difference } from '../../parallel/indexes.ts';
import { parallelIndexPass, planFor } from '../../parallel/pass.ts';
import { ScanPool } from '../../parallel/pool.ts';

const DEFAULT_PATH = '/home/hech/.cache/uno-lab/sales-q3-50m.csv';
/** Reads in flight, as the parallel bench runs it. */
const READS = 4;
const KB = 1024;
const MB = KB * KB;
/** Writing this to clear_refs resets the peak resident set size. */
const RESET_PEAK = '5';
/** How often the main thread samples its own ArrayBuffer bytes. */
const SAMPLE_MS = 2;

/** status reads one kB field of /proc/self/status, in bytes. */
function status(field: string): number {
  const text = readFileSync('/proc/self/status', 'utf8');
  const line = text.split('\n').find((l) => l.startsWith(`${field}:`));
  if (line === undefined) throw new Error(`no ${field} in /proc/self/status`);
  return Number(line.split(/\s+/)[1]) * KB;
}

function resetPeak(): void {
  writeFileSync('/proc/self/clear_refs', RESET_PEAK);
}

interface Peak {
  label: string;
  ms: number;
  rssBeforeMB: number;
  peakMB: number;
  peakOverBeforeMB: number;
  mainArrayBuffersPeakMB: number;
}

/** watch runs `fn` and reports the peak resident set over the one before. */
async function watch(label: string, fn: () => Promise<void>): Promise<Peak> {
  globalThis.gc?.();
  resetPeak();
  const before = status('VmRSS');
  let mainPeak = 0;
  const timer = setInterval(() => {
    mainPeak = Math.max(mainPeak, process.memoryUsage().arrayBuffers);
  }, SAMPLE_MS);
  const started = performance.now();
  await fn();
  const ms = performance.now() - started;
  clearInterval(timer);
  const peak = status('VmHWM');
  return {
    label,
    ms: Math.round(ms),
    rssBeforeMB: Math.round(before / MB),
    peakMB: Math.round(peak / MB),
    peakOverBeforeMB: Math.round((peak - before) / MB),
    mainArrayBuffersPeakMB: Math.round(mainPeak / MB),
  };
}

async function formatOf(source: ByteSource): Promise<Format> {
  const format = await peekFormat('bench.csv', source);
  if (format === undefined) throw new Error('the file read as empty');
  return format;
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? DEFAULT_PATH;
  const width = Number(process.argv[3] ?? '0');
  const source = await nodeSource(path);
  try {
    const format = await formatOf(source);
    let peak: Peak;
    if (width === 0) {
      const ctx = contextFor(source, format, TUNING);
      peak = await watch('sequential', () => indexPass(ctx));
    } else {
      const pool = await ScanPool.start(width);
      try {
        const plan = planFor(width, READS, 'block');
        const ctx = contextFor(source, format, TUNING);
        peak = await watch(
          `parallel ${width} workers, window ${plan.window} chunks = ${(plan.window * TUNING.chunkBytes) / MB} MB`,
          () => parallelIndexPass(ctx, pool, plan),
        );
        const want = contextFor(source, format, TUNING);
        await indexPass(want);
        const differs = difference(ctx.index, want.index);
        if (differs !== undefined) throw new Error(`${width}: ${differs}`);
      } finally {
        await pool.close();
      }
    }
    process.stdout.write(`${JSON.stringify(peak)}\n`);
  } finally {
    await source.close();
  }
}

await main();
