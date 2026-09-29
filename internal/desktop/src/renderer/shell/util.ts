// What every part of the shell reaches for: an element the markup promised, and
// an error as something to say.

export function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * settled is `run` once `ms` pass with no trigger, and never twice at once:
 * a trigger while a run is out is answered by that run. It is how the window
 * getting the focus asks the buckets -- alt-tabbing through the window on the
 * way somewhere else asks nothing, and coming back asks once.
 */
export function settled(ms: number, run: () => Promise<void>): () => void {
  let wait: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  return () => {
    clearTimeout(wait);
    wait = setTimeout(() => {
      if (running) return;
      running = true;
      void run().finally(() => {
        running = false;
      });
    }, ms);
  };
}
