/**
 * @fileoverview Numbers and times written in the app's language: a number
 * compactly and a time as a short clock, in every locale the app ships, and
 * again after the language changes.
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { baseLocale, locales, setLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";
import { Language } from "@renderer/language";
import { clock, compact, compactsExactly, percent, places } from "@renderer/locale";
import { PSEUDO_LOCALE } from "@scripts/pseudo";
import { Kept } from "./kept.ts";

/** Numbers with a digit past the one a compact form keeps. */
const MILLIONS = 1_204_000;
const THOUSANDS = 12_345;

/** The no-break space Intl writes between a number and its unit, so a label never wraps there. */
const NBSP = "\u00a0";

/** How each language writes MILLIONS and THOUSANDS compactly. */
const COMPACT: Record<Locale, { millions: string; thousands: string }> = {
  "en-US": { millions: "1.2M", thousands: "12.3K" },
  "en-GB": { millions: "1.2m", thousands: "12.3k" },
  es: { millions: `1,2${NBSP}M`, thousands: `12,3${NBSP}mil` },
  "pt-BR": { millions: `1,2${NBSP}mi`, thousands: `12,3${NBSP}mil` },
  "pt-PT": { millions: `1,2${NBSP}M`, thousands: `12,3${NBSP}mil` },
  // Intl has no such locale, and writes the pseudo-locale as English.
  [PSEUDO_LOCALE]: { millions: "1.2M", thousands: "12.3K" },
};

/** How each language writes 1,234.5 to two decimals. */
const PLACES: Record<Locale, string> = {
  "en-US": "1,234.50",
  "en-GB": "1,234.50",
  es: "1234,50",
  "pt-BR": "1.234,50",
  "pt-PT": "1234,50",
  [PSEUDO_LOCALE]: "1,234.50",
};

/** How each language writes a quarter, and a share under a tenth, as a percent. */
const PERCENT: Record<Locale, { quarter: string; small: string }> = {
  "en-US": { quarter: "25%", small: "8.1%" },
  "en-GB": { quarter: "25%", small: "8.1%" },
  es: { quarter: `25${NBSP}%`, small: `8,1${NBSP}%` },
  "pt-BR": { quarter: "25%", small: "8,1%" },
  "pt-PT": { quarter: "25%", small: "8,1%" },
  [PSEUDO_LOCALE]: { quarter: "25%", small: "8.1%" },
};

/** The most decimals Intl writes. */
const DECIMALS_MOST = 100;

/** Date counts months from 0. */
const OCTOBER = 9;

/** 29 October 2026 at 14:32 where the test runs, so a clock reads the same on any machine. */
const AT = new Date(2026, OCTOBER, 29, 14, 32).getTime();

/** The midnights either side of AT, where the test runs. */
const DAY_BEGINS = new Date(2026, OCTOBER, 29).getTime();
const DAY_ENDS = new Date(2026, OCTOBER, 30).getTime();

/** How each language writes AT: the time alone, and with its date. */
const CLOCK: Record<Locale, { time: string; dated: string }> = {
  "en-US": { time: "2:32 PM", dated: "10/29/26, 2:32 PM" },
  "en-GB": { time: "14:32", dated: "29/10/2026, 14:32" },
  es: { time: "14:32", dated: "29/10/26, 14:32" },
  "pt-BR": { time: "14:32", dated: "29/10/2026, 14:32" },
  "pt-PT": { time: "14:32", dated: "29/10/26, 14:32" },
  // Intl has no such locale, and writes the pseudo-locale as English.
  [PSEUDO_LOCALE]: { time: "2:32 PM", dated: "10/29/26, 2:32 PM" },
};

/** The languages a change from baseLocale goes to. */
const OTHER_LOCALES = locales.filter((locale) => locale !== baseLocale);

/** How the app writes MILLIONS and THOUSANDS now, in the shape of a row of COMPACT. */
function compacted(): { millions: string; thousands: string } {
  return { millions: compact(MILLIONS), thousands: compact(THOUSANDS) };
}

/** What clock writes for AT when the time is `now`. */
function seenAt(now: number): string {
  vi.setSystemTime(now);
  return clock(AT);
}

/** How the app writes AT now, in the shape of a row of CLOCK, ending with the time at AT. */
function clocked(): { time: string; dated: string } {
  const dated = seenAt(DAY_ENDS);
  return { time: seenAt(AT), dated };
}

beforeEach(() => {
  void setLocale(baseLocale, { reload: false });
  vi.useFakeTimers({ now: AT });
});

afterEach(() => {
  vi.useRealTimers();
});

test.each(locales)("%s writes a number compactly", (locale) => {
  void setLocale(locale, { reload: false });
  expect(compacted()).toEqual(COMPACT[locale]);
});

test("a compact number keeps one fraction digit, and none when the digit would be 0", () => {
  expect(compact(0)).toBe("0");
  expect(compact(999)).toBe("999");
  expect(compact(1_204)).toBe("1.2K");
  expect(compact(1_250_000)).toBe("1.3M");
  expect(compact(1_000_000_000)).toBe("1B");
  expect(compact(-12_000)).toBe("-12K");
});

test("a compact number at the top of its range rounds up: 10K, and 1M in the next unit", () => {
  expect(compact(9_999)).toBe("10K");
  expect(compact(999_999)).toBe("1M");
});

test("compact() says when it rounds a number, as Spanish writes a billion in millions", () => {
  expect(compactsExactly(1_200_000)).toBe(true);
  expect(compactsExactly(1_250_000)).toBe(false);
  expect(compactsExactly(999_999)).toBe(false);
  expect(compact(1_050_000_000)).toBe("1.1B");
  expect(compactsExactly(1_050_000_000)).toBe(false);
  void setLocale("es", { reload: false });
  expect(compact(1_050_000_000)).toBe(`1050${NBSP}M`);
  expect(compactsExactly(1_050_000_000)).toBe(true);
});

test.each(locales)("%s writes a number to the decimals asked for", (locale) => {
  void setLocale(locale, { reload: false });
  expect(places(1_234.5, 2)).toBe(PLACES[locale]);
});

test("a number is written to as many decimals as each call asks for, rounded past them", () => {
  expect([places(0.5, 0), places(0.5, 1), places(0.5, 3), places(0.0001, 4)]).toEqual([
    "1",
    "0.5",
    "0.500",
    "0.0001",
  ]);
  // Outside the decimals Intl writes, places() keeps to them, where Intl throws.
  expect([places(0.5, -1), places(1e-120, 120)]).toEqual(["1", `0.${"0".repeat(DECIMALS_MOST)}`]);
});

test.each(locales)("%s writes a share as a percent", (locale) => {
  void setLocale(locale, { reload: false });
  expect({ quarter: percent(0.25), small: percent(0.0812) }).toEqual(PERCENT[locale]);
});

test("a share keeps two significant digits, so a small one never reads as none", () => {
  const written = [percent(1), percent(0.333), percent(0.004), percent(0.000012)];
  expect(written).toEqual(["100%", "33%", "0.4%", "0.0012%"]);
});

test.each(locales)("%s writes a time short, and with its date from another day", (locale) => {
  void setLocale(locale, { reload: false });
  const { time, dated } = CLOCK[locale];
  expect(seenAt(AT)).toBe(time);
  expect(seenAt(DAY_ENDS - 1)).toBe(time);
  expect(seenAt(DAY_ENDS)).toBe(dated);
  // A time tomorrow needs its date as much as one yesterday.
  expect(seenAt(DAY_BEGINS)).toBe(time);
  expect(seenAt(DAY_BEGINS - 1)).toBe(dated);
});

test("a next try a day out keeps its date, so it never reads as the failure it follows", () => {
  const failed = new Date(2026, OCTOBER, 28, 14, 32).getTime();
  vi.setSystemTime(failed + 1);
  expect(clock(failed)).toBe(CLOCK[baseLocale].time);
  expect(clock(AT)).toBe(CLOCK[baseLocale].dated);
});

test.each(OTHER_LOCALES)("a change to %s writes the next number and time in it", (locale) => {
  const language = new Language(new Kept(), [baseLocale], locales);
  expect(compacted()).toEqual(COMPACT[baseLocale]);
  expect(clocked()).toEqual(CLOCK[baseLocale]);
  language.choose(locale);
  expect(compacted()).toEqual(COMPACT[locale]);
  expect(clocked()).toEqual(CLOCK[locale]);
  language.choose(baseLocale);
  expect(compacted()).toEqual(COMPACT[baseLocale]);
  expect(clocked()).toEqual(CLOCK[baseLocale]);
});
