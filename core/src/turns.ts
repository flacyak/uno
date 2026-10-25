/**
 * @fileoverview Turns: effects that run one at a time, in the order they were
 * asked for. The engine's edit log and the connections folder each change
 * through one. Beside it, `awaited` runs Promise code as a turn.
 *
 * Effect's Semaphore is not used for this. It frees its permit before it
 * wakes the fiber waiting longest, so a turn asked for in between takes the
 * permit ahead of the queue, and the engine's edits would run out of order.
 */

import { Deferred, Effect } from 'effect';

export class Turns {
  /** The turn before, done or not. The next turn waits for it. */
  private last: Effect.Effect<void> = Effect.void;

  /**
   * next runs `effect` as the next turn. It takes its place in the order the
   * moment it is run, starts after the turn before it has ended, however that
   * one ended, and lets the turn after it go however it ends itself. Its
   * failure is its caller's alone.
   *
   * @param effect What the turn does.
   * @return The turn's result, or its failure as it is.
   */
  next<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const before = this.last;
      const done = Deferred.makeUnsafe<void>();
      this.last = Deferred.await(done);
      return before.pipe(
        Effect.andThen(effect),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      );
    });
  }

  /** drained completes once every turn asked for so far has ended. */
  get drained(): Effect.Effect<void> {
    return this.last;
  }
}

/**
 * awaited runs Promise code as an Effect that fails with whatever the Promise
 * rejected with, as it is: a Refusal fails the Effect as itself, and
 * `Effect.runPromise` rejects with the very value again.
 *
 * @param run Starts the Promise.
 * @return The Promise's value, or its rejection as the failure.
 */
export function awaited<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: run, catch: (err) => err });
}
