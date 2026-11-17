/**
 * @fileoverview What an over-time chart calls its periods in the app's
 * language, alone or with the larger period they start ("Mar 2024", "Apr"),
 * from a key that counts a size from 1970 as a time fold's does. Intl writes
 * each in UTC, so the viewer's zone never moves it, and a quarter is a message.
 */

import { civilFromDays, daysFromCivil, EPOCH_YEAR } from "@date";
import { m } from "@paraglide/messages";
import { getLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";
import { sundayOf } from "@tally";
import type { Per } from "@tally";

const DAY_HOURS = 24;
const YEAR_MONTHS = 12;
const QUARTER_MONTHS = 3;
const YEAR_QUARTERS = 4;
const HOUR_MS = 3_600_000;
const NARROW = /\u202f/gu;
const NO_BREAK = "\u00a0";

/** mod is `n` modulo `of`, from 0 up, for keys before 1970 too. */
export const mod = (n: number, of: number): number => ((n % of) + of) % of;

/** monthStart is the hour from 1970 the month `month` months from January 1970 starts. */
function monthStart(month: number): number {
  const year = EPOCH_YEAR + Math.floor(month / YEAR_MONTHS);
  return daysFromCivil(year, mod(month, YEAR_MONTHS) + 1, 1) * DAY_HOURS;
}

/** The hour from 1970 a period of each size starts, from its key. */
const STARTS: Readonly<Record<Per, (key: number) => number>> = {
  hour: (hour) => hour,
  day: (day) => day * DAY_HOURS,
  week: (week) => sundayOf(week) * DAY_HOURS,
  month: monthStart,
  quarter: (quarter) => monthStart(quarter * QUARTER_MONTHS),
  year: (year) => monthStart(year * YEAR_MONTHS),
};

/** larger gives the period a label carries: an hour's day key, a year's own key, else the year. */
export function larger(per: Per, key: number): number {
  const day = Math.floor(STARTS[per](key) / DAY_HOURS);
  if (per === "hour") return day;
  return per === "year" ? key : civilFromDays(day).year;
}

const YEARS: Intl.DateTimeFormatOptions = { year: "numeric" };

/** What a label writes alone, and carrying its larger period. */
type Writes = readonly [Intl.DateTimeFormatOptions, Intl.DateTimeFormatOptions];
const DAYS: Writes = [
  { month: "short", day: "numeric" },
  { ...YEARS, month: "short", day: "numeric" },
];
const HOURS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** What a label of each size but the quarter writes. */
const FORMATS: Readonly<Record<Exclude<Per, "quarter">, Writes>> = {
  hour: [HOURS, { ...HOURS, month: "short", day: "numeric" }],
  day: DAYS,
  week: DAYS,
  month: [{ month: "short" }, { ...YEARS, month: "short" }],
  year: [YEARS, YEARS],
};

/** The formats made for the app's language, by name, made anew as it changes. */
let made: { locale: Locale; formats: Map<string, Intl.DateTimeFormat> } | undefined;

/** format gives the format of `options`, named `name`, in the app's language, in UTC. */
function format(name: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = getLocale();
  if (made?.locale !== locale) made = { locale, formats: new Map() };
  let held = made.formats.get(name);
  if (held === undefined) {
    held = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    made.formats.set(name, held);
  }
  return held;
}

/** dated gives the instant a period of `per` keyed `key` starts, for Intl to write. */
const dated = (per: Per, key: number): Date => new Date(STARTS[per](key) * HOUR_MS);

/**
 * label gives what the column of a period of `per` keyed `key` is labelled,
 * with the larger period it starts where `carried`: "Mar", or "Mar 2024".
 */
export function label(per: Per, key: number, carried: boolean): string {
  if (per === "quarter") {
    const n = mod(key, YEAR_QUARTERS) + 1;
    if (!carried) return m.chart_quarter_short({ n });
    const year = format("year", YEARS).format(dated(per, key));
    return m.chart_quarter({ n, year });
  }
  const options = FORMATS[per][carried ? 1 : 0];
  // ICU's narrow space before PM is no mono character: a no-break one is a ch.
  return format(`${per} ${carried}`, options).format(dated(per, key)).replace(NARROW, NO_BREAK);
}

/** What a period's full name writes, for each size but the quarter's, which is a message. */
const NAMES: Readonly<Record<"day" | "month" | "year", Intl.DateTimeFormatOptions>> = {
  day: { dateStyle: "full" },
  month: { year: "numeric", month: "long" },
  year: YEARS,
};
const LONG: Intl.DateTimeFormatOptions = { dateStyle: "long" };

/**
 * fullName gives a period's full name, as the tooltip says it: "Monday, 4 March
 * 2024", "week of 3 March 2024", "4 March 2024, 14:00 to 15:00", "Q1 2024".
 */
export function fullName(per: Per, key: number): string {
  const write = (name: string, options: Intl.DateTimeFormatOptions, at: number): string =>
    format(name, options).format(dated(per, at)).replace(NARROW, NO_BREAK);
  if (per === "quarter") return label(per, key, true);
  if (per === "week") return m.chart_period_week({ day: write("long", LONG, key) });
  if (per !== "hour") return write(`${per} name`, NAMES[per], key);
  const hour = (at: number): string => write("hour false", FORMATS.hour[0], at);
  return m.chart_period_hour({ day: write("long", LONG, key), from: hour(key), to: hour(key + 1) });
}
