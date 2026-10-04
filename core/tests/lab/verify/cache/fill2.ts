/**
 * @fileoverview fill.ts with its two counting faults fixed, for the parent to
 * run alone:
 *
 * - Collections asked for with gc() are left out of the automatic pauses by
 *   their FORCED flag. fill.ts drops them one setImmediate turn after asking,
 *   before node has delivered them, so they land in the next level's count.
 * - The cache's budget is unbounded, so the last level stops at its level.
 *   fill.ts sets the budget to the last level, so held never reaches it and
 *   the loop reads every block of the file through a full, evicting cache.
 *
 * Usage, from core/:
 *   node --experimental-transform-types --import ../paths.js \
 *     tests/lab/verify/cache/fill2.ts <file.csv> <level MB>...
 */

import { basename } from 'node:path';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import v8 from 'node:v8';

import { Pages } from '@engine';
import { nodeSource } from '@store/node';
import { collector, heapUsed, layoutOf } from '../../cache/layout.ts';

const MB = 1 << 20;
const GC_SAMPLES = 3;
/** Turns to wait for node to hand over gc entries. */
const DELIVERY_TURNS = 3;
const KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

interface Pause {
  ms: number;
  kind: string;
  forced: boolean;
}

const pauses: Pause[] = [];

async function delivered(): Promise<Pause[]> {
  for (let t = 0; t < DELIVERY_TURNS; t++) await yieldTurn();
  return pauses.splice(0);
}

const [file, ...levels] = process.argv.slice(2);
if (file === undefined || levels.length === 0) {
  throw new Error('usage: fill2.ts <file.csv> <level MB>...');
}
const gc = collector();
const source = await nodeSource(file);
try {
  const layout = await layoutOf(basename(file), source);
  const pages = new Pages(
    basename(file),
    source,
    layout.format,
    layout.index,
    Number.POSITIVE_INFINITY,
  );
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const d = e.detail as { kind: number; flags: number };
      pauses.push({
        ms: e.duration,
        kind: KINDS[d.kind] ?? String(d.kind),
        forced: (d.flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED) !== 0,
      });
    }
  });
  gc();
  observer.observe({ entryTypes: ['gc'] });
  process.stdout.write(
    `${JSON.stringify({ t: 'limit', heapSizeLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / MB), pointerCompression: (process.config.variables as Record<string, unknown>)['v8_enable_pointer_compression'] ?? null })}\n`,
  );
  let block = 0;
  for (const level of levels.map((l) => Number(l) * MB)) {
    while (pages.held < level && block < layout.blocks) {
      await pages.records(block++);
    }
    const auto = (await delivered()).filter((p) => !p.forced);
    const longest = auto.reduce<Pause | undefined>(
      (a, p) => (a === undefined || p.ms > a.ms ? p : a),
      undefined,
    );
    const fullGcMs: number[] = [];
    for (let s = 0; s < GC_SAMPLES; s++) {
      const started = performance.now();
      gc();
      fullGcMs.push(performance.now() - started);
    }
    const afterForced = await delivered();
    process.stdout.write(
      `${JSON.stringify({
        t: 'level',
        levelMB: level / MB,
        heldMB: pages.held / MB,
        heapMB: heapUsed() / MB,
        rssMB: process.memoryUsage.rss() / MB,
        longestAutoMs: longest?.ms ?? 0,
        longestAutoKind: longest?.kind ?? null,
        autoMajors: auto.filter((p) => p.kind === 'major').length,
        forcedSeenAfterwards: afterForced.filter((p) => p.forced).length,
        fullGcMs,
      })}\n`,
    );
  }
  observer.disconnect();
} finally {
  await source.close();
}
