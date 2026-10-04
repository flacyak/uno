// Timestamps in Go's formats.

/** time.Now().UTC().Truncate(time.Second). */
export function nowTruncated(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * rfc3339 formats a Date the way `encoding/json` writes a `time.Time`
 * truncated to the second: whole seconds only.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Go's zero time.Time: January 1 of year 1. Date.UTC reads a year under 100
// as 19xx, so the year is set separately.
const ZERO_TIME = ((): number => {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  return d.getTime();
})();

/**
 * isZeroTime reports whether `d` is absent, invalid, the Unix epoch, or Go's
 * zero time.Time.
 */
export function isZeroTime(d: Date | undefined): boolean {
  if (d === undefined) return true;
  const at = d.getTime();
  return Number.isNaN(at) || at === 0 || at === ZERO_TIME;
}

/**
 * parseTime reads a timestamp. Returns undefined for an empty, unparseable
 * or zero time.
 */
export function parseTime(s: string | undefined): Date | undefined {
  if (s === undefined || s === "") return undefined;
  const d = new Date(s);
  return isZeroTime(d) ? undefined : d;
}
