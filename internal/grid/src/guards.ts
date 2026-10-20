// Type guards over values read from outside: a JSON file, a message off the
// wire, a program's output.

/** isRecord is whether `v` is a plain object, which a JSON object parses to. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** isOneOf is whether `v` is one of `values`, which narrows it to their type. */
export function isOneOf<T extends string>(
  values: readonly T[],
  v: unknown,
): v is T {
  return values.some((value) => value === v);
}
