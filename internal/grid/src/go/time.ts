// Timestamps, spelled the way Go spells them.

/** time.Now().UTC().Truncate(time.Second). */
export function nowTruncated(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * rfc3339 is what `encoding/json` writes for a `time.Time`.
 *
 * `toISOString` emits milliseconds. Go, on a value already truncated to the
 * second, does not -- and a .unof written by either build should look the same
 * in a diff.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The zero time.Time, which is what "never saved" looks like in a manifest. */
export function isZeroTime(d: Date | undefined): boolean {
  return d === undefined || Number.isNaN(d.getTime()) || d.getTime() === 0;
}

/**
 * parseTime reads a timestamp back. An unparseable one is treated as absent
 * rather than as a failure: a manifest with a broken date is still a manifest,
 * and the next save writes a good one.
 */
export function parseTime(s: string | undefined): Date | undefined {
  if (s === undefined || s === "") return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
