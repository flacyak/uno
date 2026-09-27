// The locale the app speaks, for what is written without a message of its own:
// numbers, sizes and lists.
//
// A message is already in the app's language. A number written beside it has
// to be in the same one, or a German sentence counts its rows the English way.
// toLocaleString() with no locale follows the operating system, which is a
// different setting from the app's.

import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import type { Locale } from "../paraglide/runtime.js";

/** The formatter for the locale it was made in, kept until the locale changes. */
let grouping: { locale: Locale; format: Intl.NumberFormat } | undefined;

/** num is a count as the app's locale writes it: 1,204 in English. */
export function num(n: number): string {
  const locale = getLocale();
  if (grouping?.locale !== locale) grouping = { locale, format: new Intl.NumberFormat(locale) };
  return grouping.format.format(n);
}

/** How many of one unit make the next: bytes in a KB, KB in a MB. */
const UNIT_STEP = 1024;

/** The units above a byte, smallest first. */
const UNITS = [m.size_kb, m.size_mb, m.size_gb, m.size_tb] as const;

/** A size under this many of its unit keeps one decimal place: 3.2 MB, 32 MB. */
const DECIMAL_BELOW = 10;

/** bytes is a file's size in the largest unit that keeps it above one: 3.2 MB. */
export function bytes(n: number): string {
  if (n < UNIT_STEP) return m.size_bytes({ count: n });
  let size = n / UNIT_STEP;
  let unit = 0;
  while (size >= UNIT_STEP && unit < UNITS.length - 1) {
    size /= UNIT_STEP;
    unit++;
  }
  const digits = size < DECIMAL_BELOW ? 1 : 0;
  const written = new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(size);
  return UNITS[unit]!({ size: written });
}

/** list is several names as the locale sets them side by side: a, b, c. */
export function list(names: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: "unit", style: "short" }).format(names);
}
