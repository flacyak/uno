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

// What encoding/json writes for a time.Time nothing ever set: the zero value
// is January 1 of year 1, which is not the Unix epoch `new Date(0)` names.
// Date.UTC reads a year under 100 as 19xx, so the year is set on its own.
const ZERO_TIME = ((): number => {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  return d.getTime();
})();

/**
 * The zero time.Time, which is what "never saved" looks like in a manifest.
 * The Unix epoch counts as one too: nothing was saved in 1970, and a build
 * that took `new Date(0)` for the zero may have written it.
 */
export function isZeroTime(d: Date | undefined): boolean {
  if (d === undefined) return true;
  const at = d.getTime();
  return Number.isNaN(at) || at === 0 || at === ZERO_TIME;
}

/**
 * parseTime reads a timestamp back. An unparseable one is treated as absent
 * rather than as a failure: a manifest with a broken date is still a manifest,
 * and the next save writes a good one. So is the zero time.Time, which the Go
 * build writes for a stamp it never set: read as a date it would be kept as
 * the moment of creation, and the next save would never fill it in.
 */
export function parseTime(s: string | undefined): Date | undefined {
  if (s === undefined || s === "") return undefined;
  const d = new Date(s);
  return isZeroTime(d) ? undefined : d;
}
