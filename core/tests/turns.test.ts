/**
 * @fileoverview Turns run one at a time in the order they were asked for,
 * whenever they were asked for; a failed or interrupted turn lets the next
 * one go; and the drain waits for every turn asked for so far.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { Effect } from 'effect';
import { expect, test } from 'vite-plus/test';

import { Turns, awaited } from '@turns';

/** Milliseconds a turn holds the queue, long enough for others to line up. */
const HOLD_MS = 5;

test('a turn asked for the moment the queue frees up still waits its turn', async () => {
  const turns = new Turns();
  const ran: string[] = [];
  const turn = (name: string, ms = 0): Promise<void> =>
    Effect.runPromise(
      turns.next(
        awaited(async () => {
          await sleep(ms);
          ran.push(name);
        }),
      ),
    );
  const a = turn('a', HOLD_MS);
  const b = turn('b');
  // Asked for as a ends, while b has yet to start.
  const c = a.then(() => turn('c'));
  await Promise.all([a, b, c]);
  expect(ran).toEqual(['a', 'b', 'c']);
});

test('a failed turn fails with what it threw, and the next turn runs', async () => {
  const turns = new Turns();
  const thrown = new Error('this turn fails');
  const failed = Effect.runPromise(
    turns.next(
      awaited(async () => {
        await sleep(HOLD_MS);
        throw thrown;
      }),
    ),
  );
  const next = Effect.runPromise(turns.next(Effect.succeed('ran')));
  await expect(failed).rejects.toBe(thrown);
  expect(await next).toBe('ran');
});

test('an interrupted turn lets the next one go', async () => {
  const turns = new Turns();
  const abort = new AbortController();
  const stuck = Effect.runPromiseExit(turns.next(Effect.never), {
    signal: abort.signal,
  });
  const next = Effect.runPromise(turns.next(Effect.succeed('ran')));
  abort.abort();
  expect((await stuck)._tag).toBe('Failure');
  expect(await next).toBe('ran');
});

test('drained completes once every turn asked for so far has ended', async () => {
  const turns = new Turns();
  const ran: string[] = [];
  const first = Effect.runPromise(
    turns.next(
      awaited(async () => {
        await sleep(HOLD_MS);
        ran.push('first');
      }),
    ),
  );
  await Effect.runPromise(turns.drained);
  ran.push('drained');
  await first;
  expect(ran).toEqual(['first', 'drained']);
});
