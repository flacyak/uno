/**
 * @fileoverview Runs one configuration in a process of its own, so its peak
 * resident memory and its thread pool are its own, and prints what each
 * sample measured as one JSON line.
 *
 * read.bench.ts starts it as
 *   node --expose-gc --import ../paths.js \
 *     tests/lab/read/child.ts '<a Job as JSON>'
 *
 * The code is warmed by one untimed run over the job's warm-up file. A warm
 * configuration then reads its file once so every page is cached; a cold one
 * drops the file's pages before each sample. The peak is reset after the
 * warm-up, so it is the samples' own.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import type { PerformanceEntry } from 'node:perf_hooks';

import { RowIndex, TUNING } from '@engine';
import type { Tuning } from '@engine';
import { openFormat } from '@ingest';
import type { Format } from '@ingest';
import { unreachable } from '@never';
import type { ByteSource } from '@store';
import { nodeSource } from '@store/node';

import { ENGINE_CHUNK, MB } from './config.ts';
import type { Job } from './config.ts';
import { engineRun } from './engine.ts';
import { drop, resident } from './fixture.ts';
import { pipePass, splitPass, stockPass, withReadAhead } from './passes.ts';
import { openReader } from './reader.ts';

/** One sample: every number its run measured, by name. */
export type Sample = Record<string, number>;

/** ChildReport is what the child prints. */
export interface ChildReport {
  samples: Sample[];
  /** Resident memory after the warm-up, when the peak was reset. */
  baseRssMB: number;
  /** The most resident memory the process held during the samples. */
  peakRssMB: number;
}

/** Writing this to /proc/self/clear_refs resets the peak resident size. */
const RESET_PEAK = '5';
const KB = 1024;

function resetPeak(): void {
  writeFileSync('/proc/self/clear_refs', RESET_PEAK);
}

function peakRss(): number {
  const status = readFileSync('/proc/self/status', 'utf8');
  const kb = /VmHWM:\s+(\d+) kB/.exec(status)?.[1];
  if (kb === undefined) throw new Error('no VmHWM in /proc/self/status');
  return Number(kb) * KB;
}

/** collect runs a full garbage collection. The child runs with --expose-gc. */
function collect(): void {
  const gc = globalThis.gc;
  if (gc === undefined) throw new Error('run the child with --expose-gc');
  gc();
}

/** The format of the file at `path`, sniffed through `source` as View.open does. */
function formatOf(path: string, source: ByteSource): Promise<Format> {
  return openFormat(basename(path), source);
}

/** run is one pass of the job's configuration over the file at `path`. */
async function run(job: Job, path: string): Promise<Sample> {
  const { method, chunkBytes } = job.config;
  const tuning: Tuning = { ...TUNING, chunkBytes };

  switch (method.kind) {
    case 'stock':
    case 'split': {
      const raw = await nodeSource(path);
      try {
        const format = await formatOf(path, raw);
        const index = new RowIndex(format.dataStart, raw.size, tuning);
        const source = withReadAhead(raw, method.ahead);
        const times =
          method.kind === 'stock'
            ? await stockPass(source, format, index, tuning)
            : await splitPass(source, format, index, chunkBytes);
        return { ...times };
      } finally {
        await raw.close();
      }
    }
    case 'pipe': {
      const reader = await openReader(path);
      try {
        const format = await formatOf(path, {
          size: reader.size,
          read: (offset, length) => reader.fresh(offset, length),
          close: () => Promise.resolve(),
        });
        const index = new RowIndex(format.dataStart, reader.size, tuning);
        return {
          ...(await pipePass(reader, format, index, { chunkBytes, ...method })),
        };
      } finally {
        await reader.close();
      }
    }
    case 'engine':
      return { ...(await engineRun(path, method.ahead, tuning)) };
    default:
      return unreachable(method);
  }
}

/** prime reads the whole file once, so its pages are cached. */
async function prime(path: string): Promise<void> {
  const reader = await openReader(path);
  const buffer = new Uint8Array(ENGINE_CHUNK);
  try {
    for (let at = 0; at < reader.size; at += ENGINE_CHUNK) {
      await reader.into(buffer, at, ENGINE_CHUNK);
    }
  } finally {
    await reader.close();
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === undefined) throw new Error('child.ts takes a Job as JSON');
  const job = JSON.parse(arg) as Job;

  const gcs: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => {
    gcs.push(...list.getEntries());
  });
  observer.observe({ entryTypes: ['gc'] });
  const gcMsBetween = (from: number, to: number): number => {
    gcs.push(...observer.takeRecords());
    return gcs
      .filter((e) => e.startTime >= from && e.startTime < to)
      .reduce((ms, e) => ms + e.duration, 0);
  };

  await run(job, job.warmupPath);
  if (job.config.cache === 'warm') await prime(job.path);
  collect();
  resetPeak();
  const baseRss = process.memoryUsage().rss;
  const { size } = statSync(job.path);

  const samples: Sample[] = [];
  for (let i = 0; i < job.samples; i++) {
    if (job.config.cache === 'cold') drop(job.path);
    const cachedBefore = resident(job.path) / size;
    collect();
    const from = performance.now();
    const sample = await run(job, job.path);
    const to = performance.now();
    samples.push({ ...sample, gcMs: gcMsBetween(from, to), cachedBefore });
  }
  observer.disconnect();

  const report: ChildReport = {
    samples,
    baseRssMB: baseRss / MB,
    peakRssMB: peakRss() / MB,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
