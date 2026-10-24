/**
 * @fileoverview Timing for the performance tests: run a thing a few times
 * and keep the quickest, which is the run the machine interrupted least.
 */

/** fastest runs `fn` `samples` times and returns the quickest run's milliseconds. */
export async function fastest(
  samples: number,
  fn: () => Promise<void>,
): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
