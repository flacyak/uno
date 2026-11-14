/**
 * @fileoverview Package date counts the proleptic Gregorian calendar in
 * integers for the four-digit years 0000 to 9999.
 *
 * It is pure, and no `Date` is built, whose `Date.UTC` reads the years 0 to
 * 99 as 1900 to 1999.
 */

/** A calendar date: a year, a month from 1 to 12, and a day from 1. */
export interface Civil {
  year: number;
  month: number;
  day: number;
}

/** The days in each month of a year that is not a leap year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The days in a year before each month starts, leap day aside. */
const DAYS_BEFORE = MONTH_DAYS.map((_, m) =>
  MONTH_DAYS.slice(0, m).reduce((sum, days) => sum + days, 0),
);
const FEBRUARY = 2;
const YEAR_DAYS = 365;
/** Every fourth year is a leap year, but a century only every fourth. */
const LEAP_EVERY = 4;
const CENTURY = 100;
const LEAP_CENTURY_EVERY = 400;

/** Whether `year` has a 29 February. Year 0 does. */
export function isLeap(year: number): boolean {
  if (year % LEAP_EVERY !== 0) return false;
  return year % CENTURY !== 0 || year % LEAP_CENTURY_EVERY === 0;
}

/** The days in `month` of `year`. */
export function monthDays(year: number, month: number): number {
  const days = MONTH_DAYS[month - 1]!;
  return month === FEBRUARY && isLeap(year) ? days + 1 : days;
}

/** Whether `year`, `month` and `day` name a real date. */
export function isReal(year: number, month: number, day: number): boolean {
  if (month < 1 || month > MONTH_DAYS.length || day < 1) return false;
  return day <= monthDays(year, month);
}

/** The days from 0000-01-01 to the first day of `year`, from year 0 on. */
function yearStart(year: number): number {
  const leaps =
    Math.ceil(year / LEAP_EVERY) -
    Math.ceil(year / CENTURY) +
    Math.ceil(year / LEAP_CENTURY_EVERY);
  return year * YEAR_DAYS + leaps;
}

/** The year days, and readDate's minutes, count from. */
const EPOCH_YEAR = 1970;
/** The days from 0000-01-01 to 1970-01-01. */
const EPOCH = yearStart(EPOCH_YEAR);

/**
 * daysFromCivil is the days from 1970-01-01 to a real date, negative before
 * it. The caller checks the date is real, as `isReal` does.
 */
export function daysFromCivil(
  year: number,
  month: number,
  day: number,
): number {
  const leapDay = month > FEBRUARY && isLeap(year) ? 1 : 0;
  return yearStart(year) + DAYS_BEFORE[month - 1]! + leapDay + day - 1 - EPOCH;
}

/** civilFromDays is the date `days` after 1970-01-01, for labels. */
export function civilFromDays(days: number): Civil {
  const fromZero = days + EPOCH;
  // An estimate from the mean year, then set right by at most a year.
  let year = Math.floor(fromZero / (YEAR_DAYS + 1 / LEAP_EVERY));
  while (yearStart(year) > fromZero) year--;
  while (yearStart(year + 1) <= fromZero) year++;
  let day = fromZero - yearStart(year) + 1;
  let month = 1;
  while (day > monthDays(year, month)) day -= monthDays(year, month++);
  return { year, month, day };
}
