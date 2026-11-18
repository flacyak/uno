/**
 * @fileoverview An over-time chart's labels under its columns: the finest of
 * a size's natural steps whose labels stand apart, each new year carried,
 * thinned on their own in each language, and the first and last where no
 * step fits.
 */

import { afterEach, expect, test } from "vite-plus/test";

import { EPOCH_YEAR, daysFromCivil } from "@date";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ticksOf } from "@renderer/chart/timeAxis";
import type { Per, TimeLevel } from "@tally";

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** A level of `span` periods of `per` from `from`, a row in each. */
const levelOf = (per: Per, from: number, span: number): TimeLevel => ({
  per,
  from,
  span,
  offset: 0,
  rows: Array.from({ length: span }, () => 1),
  sum: [],
});

/** A new window's periods past labels two characters wide, how far left of them a label may reach, and 11 px mono's ch. */
const ACROSS = 378;
const LOW = -20;
const CH = 7;

/** January 2023, as a month's key, and the 24 months to December 2024. */
const MONTHS_A_YEAR = 12;
const JANUARY_2023 = (2023 - EPOCH_YEAR) * MONTHS_A_YEAR;
const TWO_YEARS = levelOf("month", JANUARY_2023, 2 * MONTHS_A_YEAR);

/** The words of the labels of `level` over `across` px. */
const words = (level: TimeLevel, across = ACROSS): string[] =>
  ticksOf(level, across, LOW, CH).map((tick) => tick.words.replace(/ /gu, " "));

test("two years of months label every third month, each new year carried", () => {
  expect(words(TWO_YEARS)).toStrictEqual([
    "Jan 2023",
    "Apr",
    "Jul",
    "Oct",
    "Jan 2024",
    "Apr",
    "Jul",
    "Oct",
  ]);
  expect(ticksOf(TWO_YEARS, ACROSS, LOW, CH).map((tick) => tick.at)).toStrictEqual([
    0, 3, 6, 9, 12, 15, 18, 21,
  ]);
});

test("each language thins its own labels, by how long it writes them", async () => {
  await setLocale("pt-BR", { reload: false });
  expect(words(TWO_YEARS)).toStrictEqual(["jan. de 2023", "jul.", "jan. de 2024", "jul."]);
  await setLocale("en-XA", { reload: false });
  expect(words(TWO_YEARS)).toStrictEqual([
    "Jan 2023",
    "Apr",
    "Jul",
    "Oct",
    "Jan 2024",
    "Apr",
    "Jul",
    "Oct",
  ]);
});

test("days step by weeks from a Sunday, and hours carry the day each starts", () => {
  const MARCH_DAYS = 31;
  const march = levelOf("day", daysFromCivil(2024, 3, 1), MARCH_DAYS);
  expect(words(march)).toStrictEqual(["Mar 3, 2024", "Mar 10", "Mar 17", "Mar 24", "Mar 31"]);
  const HOURS_A_DAY = 24;
  const hours = levelOf("hour", daysFromCivil(2024, 3, 4) * HOURS_A_DAY, 2 * HOURS_A_DAY);
  // A window wide enough for a label every six hours.
  const WIDE = 900;
  expect(words(hours, WIDE)).toStrictEqual([
    "Mar 4, 12:00 AM",
    "6:00 AM",
    "12:00 PM",
    "6:00 PM",
    "Mar 5, 12:00 AM",
    "6:00 AM",
    "12:00 PM",
    "6:00 PM",
  ]);
});

test("where no step's labels stand apart, the first and the last are labelled, or the first alone", () => {
  // 2024 to a placeholder in 9999.
  const FIRST = 2024;
  const LAST = 9999;
  const years = levelOf("year", FIRST - EPOCH_YEAR, LAST - FIRST + 1);
  expect(words(years)).toStrictEqual(["2024", "9999"]);
  expect(words(years, 4 * CH)).toStrictEqual(["2024"]);
});

test("a step that would label one period of several is passed by for the first and the last", () => {
  // Fourteen weeks in a window of the least width, where 13 weeks a label would name one.
  const WEEKS = 14;
  const NARROW = 192;
  const weeks = levelOf("week", 0, WEEKS);
  expect(words(weeks, NARROW)).toHaveLength(2);
});

test("days a month a label apart start at the first Sunday they span", () => {
  // The fixture's 91 days from Wednesday 1 July 2026 in a new window.
  const QUARTER_DAYS = 91;
  const days = levelOf("day", daysFromCivil(2026, 7, 1), QUARTER_DAYS);
  expect(words(days)).toStrictEqual(["Jul 5, 2026", "Aug 2", "Aug 30", "Sep 27"]);
});
