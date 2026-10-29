/**
 * @fileoverview Checks whether fill.ts's way of splitting gc entries between
 * levels works: one setImmediate turn after three forced collections, are
 * their entries delivered, or do they arrive later and land in the next
 * level's "automatic" pauses? Counts entries only, times nothing.
 *
 * Usage, from core/:
 *   node --import ../paths.js \
 *     tests/lab/verify/cache/observer.ts
 */

import { PerformanceObserver } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { collector } from '../../cache/layout.ts';

/** Forced collections, as fill.ts's GC_SAMPLES. */
const FORCED = 3;
/** Turns waited after the one fill.ts waits. */
const LATER_TURNS = 3;

const gc = collector();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) pauses.push(entry.duration);
});
observer.observe({ entryTypes: ['gc'] });

// fill.ts: await yieldTurn(); pauses.splice(0); gc() x3; await yieldTurn(); pauses.splice(0);
await yieldTurn();
pauses.splice(0);
for (let s = 0; s < FORCED; s++) gc();
await yieldTurn();
const droppedByFill = pauses.splice(0).length;

let leaked = 0;
for (let t = 0; t < LATER_TURNS; t++) {
  await yieldTurn();
  leaked += pauses.splice(0).length;
}
observer.disconnect();
process.stdout.write(
  `${JSON.stringify({ node: process.version, forced: FORCED, droppedByFill, leakedIntoNextLevel: leaked })}\n`,
);
