/**
 * @fileoverview Numbers written in the app's language: compactly, in every
 * locale the app ships, and again after the language changes.
 */

import { beforeEach, expect, test } from "vite-plus/test";

import { baseLocale, locales, setLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";
import { Language } from "@renderer/language";
import { compact } from "@renderer/locale";
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

/** The languages a change from baseLocale goes to. */
const OTHER_LOCALES = locales.filter((locale) => locale !== baseLocale);

/** How the app writes MILLIONS and THOUSANDS now, in the shape of a row of COMPACT. */
function compacted(): { millions: string; thousands: string } {
  return { millions: compact(MILLIONS), thousands: compact(THOUSANDS) };
}

beforeEach(() => {
  void setLocale(baseLocale, { reload: false });
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

test.each(OTHER_LOCALES)("a change to %s writes the next number in it", (locale) => {
  const language = new Language(new Kept(), [baseLocale], locales);
  expect(compacted()).toEqual(COMPACT[baseLocale]);
  language.choose(locale);
  expect(compacted()).toEqual(COMPACT[locale]);
  language.choose(baseLocale);
  expect(compacted()).toEqual(COMPACT[baseLocale]);
});
