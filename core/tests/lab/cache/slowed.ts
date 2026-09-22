/**
 * @fileoverview Run as a process of its own by cache.bench.ts: one cacheBytes
 * variant's sessions with a delay slept before every read, standing in for a
 * bucket.
 *
 * Those sessions spend nearly all their time asleep, so the bench runs every
 * variant at once, one process each. Each process has its own event loop and
 * engine, so one variant's work never waits behind another's.
 *
 * It talks in lines of JSON. stdin: a SlowedAsk, then "go". stdout:
 * {"t":"ready"} once the file is indexed, then {"t":"runs"} with the result.
 * The bench sends "go" once every variant is ready, so no index pass runs
 * while any session is timed.
 */

import { createInterface } from 'node:readline';

import { TUNING } from '@engine';
import { diskProvider } from '@store/node';
import { connect, indexed, openOne } from '@core-tests/engine/harness';
import { runSessions } from './session.ts';
import type { Jump, SessionRun } from './session.ts';
import { Watch } from './watch.ts';

/** Bytes in a megabyte. */
const MB = 1 << 20;

/** What the bench asks one slowed process to do. */
export interface SlowedAsk {
  /** The file's name, which picks its format. */
  name: string;
  path: string;
  /** Rows the file holds, to check the engine agrees. */
  rows: number;
  cacheMB: number;
  /** Milliseconds slept before every read, once the index is built. */
  slowMs: number;
  sessions: Jump[][];
}

/** The lines this process prints, one JSON object each. */
export type SlowedLine = { t: 'ready' } | { t: 'runs'; runs: SessionRun[] };

/** The line the bench sends to start the sessions. */
export const GO = 'go';

function say(line: SlowedLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin })[
    Symbol.asyncIterator
  ]();
  const first = await lines.next();
  if (first.done === true) throw new Error('stdin closed before the ask');
  const ask = JSON.parse(first.value) as SlowedAsk;

  const watch = new Watch(diskProvider());
  const { engine, done } = connect(
    { ...TUNING, cacheBytes: ask.cacheMB * MB },
    [watch.provider],
  );
  try {
    const src = await openOne(engine, { name: ask.name, path: ask.path });
    await indexed(src);
    if (src.progress.rows !== ask.rows) {
      throw new Error(
        `the engine counted ${src.progress.rows} rows, not ${ask.rows}`,
      );
    }
    say({ t: 'ready' });
    const go = await lines.next();
    if (go.done === true || go.value !== GO) throw new Error('no go');

    watch.delayMs = ask.slowMs;
    say({ t: 'runs', runs: await runSessions(src, watch, ask.sessions) });
  } finally {
    done();
    process.stdin.destroy();
  }
}

if (import.meta.main) await main();
