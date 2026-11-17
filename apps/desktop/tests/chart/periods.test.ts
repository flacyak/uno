/**
 * @fileoverview What an over-time chart calls its periods under its columns,
 * alone and carrying the larger period they start, in each of the app's
 * languages and the pseudo-locale, written in UTC whatever the viewer's zone.
 */

import { afterEach, expect, test } from "vite-plus/test";

import { EPOCH_YEAR, daysFromCivil } from "@date";
import { baseLocale, setLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";
import { fullName, label, larger } from "@renderer/chart/periods";
import { sundayOf } from "@tally";
import type { Per } from "@tally";

afterEach(async () => {
  await setLocale(baseLocale, { reload: false });
});

/** Monday 4 March 2024, as the key of each size: 14:00 for an hour, and its week from Sunday 3 March. */
const YEAR = 2024;
const MARCH = 3;
const DAY = daysFromCivil(YEAR, MARCH, 4);
const SUNDAY = DAY - 1;
const HOURS_A_DAY = 24;
const DAYS_A_WEEK = 7;
const MONTHS_A_YEAR = 12;
const QUARTERS_A_YEAR = 4;
const AT_TWO = 14;
const YEARS = YEAR - EPOCH_YEAR;
const KEYS: Record<Per, number> = {
  hour: DAY * HOURS_A_DAY + AT_TWO,
  day: DAY,
  week: (SUNDAY - sundayOf(0)) / DAYS_A_WEEK,
  month: YEARS * MONTHS_A_YEAR + MARCH - 1,
  quarter: YEARS * QUARTERS_A_YEAR,
  year: YEARS,
};

/** Each size's label of that period, alone and carrying its larger period, in a language. */
const LABELS: Record<Locale, Record<Per, [string, string]>> = {
  "en-US": {
    hour: ["2:00 PM", "Mar 4, 2:00 PM"],
    day: ["Mar 4", "Mar 4, 2024"],
    week: ["Mar 3", "Mar 3, 2024"],
    month: ["Mar", "Mar 2024"],
    quarter: ["Q1", "Q1 2024"],
    year: ["2024", "2024"],
  },
  "en-GB": {
    hour: ["14:00", "4 Mar, 14:00"],
    day: ["4 Mar", "4 Mar 2024"],
    week: ["3 Mar", "3 Mar 2024"],
    month: ["Mar", "Mar 2024"],
    quarter: ["Q1", "Q1 2024"],
    year: ["2024", "2024"],
  },
  es: {
    hour: ["14:00", "4 mar, 14:00"],
    day: ["4 mar", "4 mar 2024"],
    week: ["3 mar", "3 mar 2024"],
    month: ["mar", "mar 2024"],
    quarter: ["T1", "T1 2024"],
    year: ["2024", "2024"],
  },
  "pt-BR": {
    hour: ["14:00", "4 de mar., 14:00"],
    day: ["4 de mar.", "4 de mar. de 2024"],
    week: ["3 de mar.", "3 de mar. de 2024"],
    month: ["mar.", "mar. de 2024"],
    quarter: ["T1", "T1 2024"],
    year: ["2024", "2024"],
  },
  "pt-PT": {
    hour: ["14:00", "4/03, 14:00"],
    day: ["4/03", "4/03/2024"],
    week: ["3/03", "3/03/2024"],
    month: ["mar.", "03/2024"],
    quarter: ["T1", "T1 2024"],
    year: ["2024", "2024"],
  },
  "en-XA": {
    hour: ["2:00 PM", "Mar 4, 2:00 PM"],
    day: ["Mar 4", "Mar 4, 2024"],
    week: ["Mar 3", "Mar 3, 2024"],
    month: ["Mar", "Mar 2024"],
    quarter: ["⟦Ǫ1 ·⟧", "⟦Ǫ1 2024 ·⟧"],
    year: ["2024", "2024"],
  },
};

/** spaced gives `said` with the narrow no-break space ICU writes before PM as a space. */
const spaced = (said: string): string => said.replace(/\u00a0/gu, " ");

test("each size labels its period in the app's language, alone and carrying the larger period it starts", async () => {
  for (const [locale, sizes] of Object.entries(LABELS) as Array<
    [Locale, Record<Per, [string, string]>]
  >) {
    await setLocale(locale, { reload: false });
    for (const [per, [alone, carried]] of Object.entries(sizes) as Array<[Per, [string, string]]>) {
      expect([locale, per, spaced(label(per, KEYS[per], false))]).toStrictEqual([
        locale,
        per,
        alone,
      ]);
      expect([locale, per, spaced(label(per, KEYS[per], true))]).toStrictEqual([
        locale,
        per,
        carried,
      ]);
    }
  }
});

test("a label carries the day of an hour, the year of every size from day to quarter, and a year its own", () => {
  expect(larger("hour", KEYS.hour)).toBe(DAY);
  for (const per of ["day", "week", "month", "quarter"] as const)
    expect(larger(per, KEYS[per])).toBe(YEAR);
  expect(larger("year", KEYS.year)).toBe(KEYS.year);
});

test("a period before 1970, and one in year 1, are labelled from their civil date", () => {
  expect(label("month", -1, true)).toBe("Dec 1969");
  expect(label("year", 1 - EPOCH_YEAR, false)).toBe("1");
  expect(label("day", daysFromCivil(1, 1, 1), true)).toBe("Jan 1, 1");
});

test("a label holds no narrow space, which no mono font draws a character wide", () => {
  expect(label("hour", KEYS.hour, false)).not.toMatch(/\u202f/u);
});

test("the tooltip names each size's period in full, in the app's language", async () => {
  const NAMES: Record<"en-US" | "es", Record<Per, string>> = {
    "en-US": {
      hour: "March 4, 2024, 2:00 PM to 3:00 PM",
      day: "Monday, March 4, 2024",
      week: "week of March 3, 2024",
      month: "March 2024",
      quarter: "Q1 2024",
      year: "2024",
    },
    es: {
      hour: "4 de marzo de 2024, de 14:00 a 15:00",
      day: "lunes, 4 de marzo de 2024",
      week: "semana del 3 de marzo de 2024",
      month: "marzo de 2024",
      quarter: "T1 2024",
      year: "2024",
    },
  };
  for (const [locale, names] of Object.entries(NAMES) as Array<
    ["en-US" | "es", Record<Per, string>]
  >) {
    await setLocale(locale, { reload: false });
    for (const [per, name] of Object.entries(names) as Array<[Per, string]>) {
      expect([per, spaced(fullName(per, KEYS[per]))]).toStrictEqual([per, name]);
    }
  }
});
