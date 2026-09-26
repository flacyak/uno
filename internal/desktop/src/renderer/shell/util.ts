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

/** The last part of a path, whichever way its separators lean. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** The folder a path is in, by its own name: "exports" for /work/exports/q3.uno. */
export function folderName(path: string): string {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end < 0 ? "" : baseName(path.slice(0, end));
}
