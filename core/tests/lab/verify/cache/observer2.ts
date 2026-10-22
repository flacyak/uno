/**
 * @fileoverview observer.ts with each entry's kind and start, to tell which
 * collections fill.ts drops and which it counts in the next level.
 */

import { PerformanceObserver, constants } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { collector } from '../../cache/layout.ts';

const FORCED = 3;
const LATER_TURNS = 3;
const KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

const gc = collector();
type Seen = { kind: string; start: number; forced: boolean };
const pauses: Seen[] = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const d = e.detail as { kind: number; flags: number };
    pauses.push({
      kind: KINDS[d.kind] ?? String(d.kind),
      start: Math.round(e.startTime),
      forced: (d.flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED) !== 0,
    });
  }
});
observer.observe({ entryTypes: ['gc'] });

await yieldTurn();
const before = pauses.splice(0);
const forcedAt: number[] = [];
for (let s = 0; s < FORCED; s++) {
  forcedAt.push(Math.round(performance.now()));
  gc();
}
await yieldTurn();
const dropped = pauses.splice(0);
const leaked: Seen[] = [];
for (let t = 0; t < LATER_TURNS; t++) {
  await yieldTurn();
  leaked.push(...pauses.splice(0));
}
observer.disconnect();
process.stdout.write(
  `${JSON.stringify({ before, forcedAt, droppedByFill: dropped, leakedIntoNextLevel: leaked })}\n`,
);
