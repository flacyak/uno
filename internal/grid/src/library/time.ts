// Timestamps as a .unof and a .uno write them: RFC 3339, in whole seconds,
// with year 1 and the Unix epoch both read as no time at all.

/** nowTruncated is the current time to the second, as a file stamps it. */
export function nowTruncated(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * rfc3339 formats a Date as RFC 3339 in UTC, in whole seconds, the way the
 * files were first written.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The zero time of the files' first writer: January 1 of year 1. Date.UTC
// reads a year under 100 as 19xx, so the year is set separately.
const ZERO_TIME = ((): number => {
  const d = new Date(0);
  d.setUTCFullYear(1, 0, 1);
  return d.getTime();
})();

/**
 * isZeroTime reports whether `d` is absent, invalid, the Unix epoch, or the
 * year 1 zero time.
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
  if (s === undefined || s === '') return undefined;
  const d = new Date(s);
  return isZeroTime(d) ? undefined : d;
}
