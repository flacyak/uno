// Formats numbers, byte sizes and lists in the app's locale.
//
// The app's locale is a separate setting from the operating system's, so
// every formatter here is built with getLocale().

import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import type { Locale } from "../paraglide/runtime.js";

/** Cached number formatter, rebuilt when the locale changes. */
let grouping: { locale: Locale; format: Intl.NumberFormat } | undefined;

/** Cached size formatters, whole and to a tenth, rebuilt when the locale changes. */
let sizes: { locale: Locale; whole: Intl.NumberFormat; tenths: Intl.NumberFormat } | undefined;

/** A formatter that writes exactly `digits` decimals. */
function decimals(locale: Locale, digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Formats a count in the app's locale: 1,204 in English. */
export function num(n: number): string {
  const locale = getLocale();
  if (grouping?.locale !== locale) grouping = { locale, format: new Intl.NumberFormat(locale) };
  return grouping.format.format(n);
}

/** Bytes per KB, KB per MB, and so on. */
const UNIT_STEP = 1024;

/** The units above a byte, smallest first. */
const UNITS = [m.size_kb, m.size_mb, m.size_gb, m.size_tb] as const;

/** A size below this many of its unit shows one decimal: 3.2 MB, 32 MB. */
const DECIMAL_BELOW = 10;

/** Formats a byte count in the largest unit that keeps it at or above one: 3.2 MB. */
export function bytes(n: number): string {
  if (n < UNIT_STEP) return m.size_bytes({ count: n });
  let size = n / UNIT_STEP;
  let unit = 0;
  while (size >= UNIT_STEP && unit < UNITS.length - 1) {
    size /= UNIT_STEP;
    unit++;
  }
  const locale = getLocale();
  if (sizes?.locale !== locale) {
    sizes = { locale, whole: decimals(locale, 0), tenths: decimals(locale, 1) };
  }
  const written = (size < DECIMAL_BELOW ? sizes.tenths : sizes.whole).format(size);
  return UNITS[unit]!({ size: written });
}

/** Joins names as a short list in the app's locale: a, b, c. */
export function list(names: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: "unit", style: "short" }).format(names);
}
