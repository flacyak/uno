/**
 * @fileoverview Formats numbers, byte sizes, times and lists in the app's
 * locale.
 *
 * The app's locale is a separate setting from the operating system's, so
 * every formatter here is built with getLocale().
 */

import { m } from "@paraglide/messages";
import { getLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";

/** Cached number formatter, rebuilt when the locale changes. */
let grouping: { locale: Locale; format: Intl.NumberFormat } | undefined;

/** Cached fixed-decimal formatters, whole and to a tenth, rebuilt when the locale changes. */
let sizes: { locale: Locale; whole: Intl.NumberFormat; tenths: Intl.NumberFormat } | undefined;

/** Cached formatters by the decimals they write, rebuilt when the locale changes. */
let placing: { locale: Locale; formats: Map<number, Intl.NumberFormat> } | undefined;

/**
 * Cached compact formatters, rounded as compact() writes and with every digit,
 * rebuilt when the locale changes.
 */
let compacting: { locale: Locale; format: Intl.NumberFormat; exact: Intl.NumberFormat } | undefined;

/** Cached percent formatter, rebuilt when the locale changes. */
let shares: { locale: Locale; format: Intl.NumberFormat } | undefined;

/**
 * Cached time formatters, without and with the date, rebuilt when the locale
 * changes. They keep the time zone they were built in.
 */
let clocks: { locale: Locale; time: Intl.DateTimeFormat; dated: Intl.DateTimeFormat } | undefined;

/** The fixed-decimal formatters for the app's locale. */
function fixed(): { whole: Intl.NumberFormat; tenths: Intl.NumberFormat } {
  const locale = getLocale();
  if (sizes?.locale !== locale) {
    sizes = { locale, whole: decimals(locale, 0), tenths: decimals(locale, 1) };
  }
  return sizes;
}

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

/** The most decimals Intl writes, so a number finer than ten to the -100 reads as 0. */
const DECIMALS_MOST = 100;

/**
 * Formats a number with exactly `digits` decimals in the app's locale: 0.50 in
 * English, 0,50 in Spanish. It writes none for fewer than none, and
 * DECIMALS_MOST for more.
 */
export function places(n: number, digits: number): string {
  const locale = getLocale();
  const kept = Math.min(Math.max(digits, 0), DECIMALS_MOST);
  if (placing?.locale !== locale) placing = { locale, formats: new Map() };
  const format = placing.formats.get(kept) ?? decimals(locale, kept);
  placing.formats.set(kept, format);
  return format.format(n);
}

/** The fraction digits a compact number keeps: 1.2M, where 1.23M runs wider than a tick. */
const COMPACT_DIGITS = 1;

/** The most significant digits Intl writes, more than a double holds. */
const DIGITS_MOST = 21;

/** The compact formatters for the app's locale. */
function compacts(): { format: Intl.NumberFormat; exact: Intl.NumberFormat } {
  const locale = getLocale();
  if (compacting?.locale !== locale) {
    compacting = {
      locale,
      format: new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: COMPACT_DIGITS,
      }),
      exact: new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumSignificantDigits: DIGITS_MOST,
      }),
    };
  }
  return compacting;
}

/** Formats a number the short way in the app's locale: 1.2M in English, 1,2 M in Spanish. */
export function compact(n: number): string {
  return compacts().format.format(n);
}

/**
 * Whether compact() writes `n` with every digit it has: 1.2M does 1,200,000,
 * and 1.3M rounds 1,250,000.
 */
export function compactsExactly(n: number): boolean {
  const { format, exact } = compacts();
  return format.format(n) === exact.format(n);
}

/** The significant digits a share keeps: 8.1% tells a small one from none, and 33% stays short. */
const SHARE_DIGITS = 2;

/**
 * Formats a share of a whole as a percent in the app's locale: 25% and 8.1% in
 * English, 25 % in Spanish.
 */
export function percent(share: number): string {
  const locale = getLocale();
  if (shares?.locale !== locale) {
    const format = new Intl.NumberFormat(locale, {
      style: "percent",
      maximumSignificantDigits: SHARE_DIGITS,
    });
    shares = { locale, format };
  }
  return shares.format.format(share);
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
  const written = (size < DECIMAL_BELOW ? fixed().tenths : fixed().whole).format(size);
  return UNITS[unit]!({ size: written });
}

/** A second, in ms. */
export const MS_PER_SECOND = 1000;

/** Formats a time in milliseconds as seconds to one decimal, with its unit: 2.4 s. */
export function seconds(ms: number): string {
  return m.elapsed_seconds({ seconds: fixed().tenths.format(ms / MS_PER_SECOND) });
}

/**
 * Formats a time, in ms since the epoch, in the app's locale: 2:32 PM in
 * English, 14:32 in Spanish. A time on any day but today, before or after,
 * comes with its date: 29/10/26, 14:32.
 */
export function clock(ms: number): string {
  const locale = getLocale();
  if (clocks?.locale !== locale) {
    clocks = {
      locale,
      time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }),
      dated: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    };
  }
  const today = new Date(ms).toDateString() === new Date().toDateString();
  return (today ? clocks.time : clocks.dated).format(ms);
}

/** Joins names as a short list in the app's locale: a, b, c. */
export function list(names: readonly string[]): string {
  return new Intl.ListFormat(getLocale(), { type: "unit", style: "short" }).format(names);
}
