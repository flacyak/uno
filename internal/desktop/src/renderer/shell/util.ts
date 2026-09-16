// What every part of the shell reaches for: an element the markup promised, and
// an error as something to say.

export function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
