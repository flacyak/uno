/**
 * @fileoverview Run as a process of its own by cache.bench.ts: fills one page
 * cache over a file with whole blocks, level by level, and prints one JSON
 * line per level and every PROGRESS_BYTES of source on the way. A process the
 * heap limit kills leaves its last reading behind.
 *
 * At each level it reports the heap the cache took, the longest pause the
 * collector took on its own while the cache grew to that level, and the time
 * of full collections asked for once it got there.
 *
 * Usage, from core/:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/cache/fill.ts <file.csv> <level MB>...
 */

import { basename } from 'node:path';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import type { PerformanceEntry } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import v8 from 'node:v8';

import { Pages } from '@engine';
import { nodeSource } from '@store/node';
import { collector, heapUsed, layoutOf } from './layout.ts';

/** Bytes in a megabyte. */
const MB = 1 << 20;
/** Source bytes between progress lines. */
const PROGRESS_BYTES = 8 * MB;
/** Full collections timed at each level. */
const GC_SAMPLES = 3;

/** The lines this process prints, one JSON object each. */
export type FillLine =
  | { t: 'limit'; heapSizeLimit: number }
  | {
      t: 'progress';
      heldBytes: number;
      heapBytes: number;
      /** Milliseconds since the fill began, to show it slow near the limit. */
      ms: number;
    }
  | {
      t: 'level';
      levelBytes: number;
      heldBytes: number;
      heapBytes: number;
      /** The process's resident memory, as the operating system counts it. */
      rssBytes: number;
      /** The longest collection the heap triggered while filling to here. */
      longestAutoGcMs: number;
      /** Major collections the heap triggered while filling to here. */
      autoMajorGcs: number;
      /** Each full collection asked for at this level. */
      fullGcMs: number[];
    }
  | { t: 'done' };

function say(line: FillLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** isMajor reports whether a gc entry is a full mark-compact collection. */
function isMajor(entry: PerformanceEntry): boolean {
  const detail: unknown = 'detail' in entry ? entry.detail : undefined;
  return (
    typeof detail === 'object' &&
    detail !== null &&
    'kind' in detail &&
    detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR
  );
}

/** Collections the heap ran on its own since the last level. */
const pauses: { ms: number; major: boolean }[] = [];

async function main(): Promise<void> {
  const [file, ...levels] = process.argv.slice(2);
  if (file === undefined || levels.length === 0) {
    throw new Error('usage: fill.ts <file.csv> <level MB>...');
  }
  const levelBytes = levels.map((l) => Number(l) * MB);
  const gc = collector();
  say({ t: 'limit', heapSizeLimit: v8.getHeapStatistics().heap_size_limit });

  const source = await nodeSource(file);
  try {
    const layout = await layoutOf(basename(file), source);
    const pages = new Pages(
      basename(file),
      source,
      layout.format,
      layout.index,
      Math.max(...levelBytes),
    );
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        pauses.push({ ms: entry.duration, major: isMajor(entry) });
      }
    });
    gc();
    observer.observe({ entryTypes: ['gc'] });

    let block = 0;
    let told = 0;
    const began = performance.now();
    for (const level of levelBytes) {
      while (pages.held < level && block < layout.blocks) {
        await pages.records(block++);
        if (pages.held - told >= PROGRESS_BYTES) {
          told = pages.held;
          say({
            t: 'progress',
            heldBytes: pages.held,
            heapBytes: heapUsed(),
            ms: performance.now() - began,
          });
        }
      }
      // Let the observer deliver the collections of this stretch.
      await yieldTurn();
      const auto = pauses.splice(0);
      const fullGcMs: number[] = [];
      for (let s = 0; s < GC_SAMPLES; s++) {
        const started = performance.now();
        gc();
        fullGcMs.push(performance.now() - started);
      }
      await yieldTurn();
      pauses.splice(0);
      say({
        t: 'level',
        levelBytes: level,
        heldBytes: pages.held,
        heapBytes: heapUsed(),
        rssBytes: process.memoryUsage.rss(),
        longestAutoGcMs: Math.max(0, ...auto.map((p) => p.ms)),
        autoMajorGcs: auto.filter((p) => p.major).length,
        fullGcMs,
      });
    }
    observer.disconnect();
    say({ t: 'done' });
  } finally {
    await source.close();
  }
}

if (import.meta.main) await main();
