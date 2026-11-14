/**
 * @fileoverview Package date reads the date a spreadsheet cell writes, as
 * minutes since 1970-01-01 00:00 as written, and counts the proleptic
 * Gregorian calendar in integers for the four-digit years 0000 to 9999.
 *
 * It is pure, and no `Date` is built, whose `Date.UTC` reads the years 0 to
 * 99 as 1900 to 1999. readDate and the calendar share this file: under the
 * test runner that holds readDate to its speed, a call between modules
 * costs about as much as the read.
 */

import { isSpace, trimSpace } from '@go';

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

/** How a date written 03/04/2024 reads: day first (3 April) or month first (4 March). */
export type Order = 'day' | 'month';

/** The order a column's sample shows: one of them, or either when none decides. */
export type ShownOrder = Order | 'either';

const MINUTE_SECONDS = 60;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;
const DAY_MINUTES = DAY_HOURS * HOUR_MINUTES;
/** A year is written in four digits, and a month, day or time field in two at most. */
const YEAR_DIGITS = 4;
const FIELD_DIGITS = 2;
const DECIMAL = 10;

const code = (c: string): number => c.charCodeAt(0);
const ZERO = code('0');
const NINE = code('9');
const COLON = code(':');
const POINT = code('.');
const PLUS = code('+');
const MINUS = code('-');
const SLASH = code('/');
const SPACE = code(' ');
const UPPER_T = code('T');
const LOWER_T = code('t');
const UPPER_Z = code('Z');
const LOWER_Z = code('z');
/** Printable ASCII, none of which is White_Space. */
const PRINTABLE_FIRST = code('!');
const PRINTABLE_LAST = code('~');

/**
 * readDate is `v` as minutes since 1970-01-01 00:00 as written, or undefined
 * when it is not a date. A date with a time of day counts its hours and
 * minutes; seconds and an offset are checked and left out, so a cell counts
 * in the period it writes. A year-last date reads by `order`, and a year and
 * month as its first day. Surrounding White_Space is trimmed.
 * It scans a character at a time, with no regular expression, since a chart
 * reads every cell of its column.
 */
export function readDate(v: string, order: Order): number | undefined {
  let from = 0;
  let to = v.length;
  while (from < to && spaceAt(v, from)) from++;
  while (to > from && spaceAt(v, to - 1)) to--;

  // Three fields of digits, or a year and month: field1 ends at end1 and so on.
  const field1 = readDigits(v, from, to);
  const end1 = digitsStop;
  const sep = v.charCodeAt(end1);
  const yearLast =
    end1 > from &&
    end1 - from <= FIELD_DIGITS &&
    isSeparator(sep) &&
    isDigit(v.charCodeAt(end1 + 1));
  if (end1 - from !== YEAR_DIGITS && !yearLast) {
    return named(v.slice(from, to));
  }
  if (!isSeparator(sep)) return undefined;
  const field2 = readDigits(v, end1 + 1, to);
  const end2 = digitsStop;
  const length2 = end2 - end1 - 1;
  if (length2 < 1 || length2 > FIELD_DIGITS) return undefined;

  if (!yearLast && end2 === to) {
    // A year and month, 2024-03, reads as its first day.
    const yearMonth = sep === MINUS && length2 === FIELD_DIGITS;
    return yearMonth ? minutes(field1, field2, 1, 0) : undefined;
  }
  if (v.charCodeAt(end2) !== sep) return undefined;
  const field3 = readDigits(v, end2 + 1, to);
  const end3 = digitsStop;
  const length3 = end3 - end2 - 1;
  const fits = yearLast
    ? length3 === YEAR_DIGITS
    : length3 >= 1 && length3 <= FIELD_DIGITS;
  if (!fits) return undefined;

  const time = end3 === to ? 0 : timeOfDay(v, end3, to);
  if (time === undefined) return undefined;
  if (!yearLast) return minutes(field1, field2, field3, time);
  return order === 'day'
    ? minutes(field3, field2, field1, time)
    : minutes(field3, field1, field2, time);
}

/**
 * How a date written year last begins, as readDate tells it: a field of one
 * or two digits, a separator, then a digit.
 */
const YEAR_LAST = /^\d{1,2}[-/.]\d/;

/**
 * inferOrder names the order a column's sampled `values` read in. A date
 * written year last whose first field is over 12 reads only day first, and
 * one whose second is over 12 only month first. The order is `day` when some
 * value reads only day first and none only month first, `month` the other
 * way round, and `either` when none decides or they disagree. It is
 * undefined when no value is a date written year last.
 */
export function inferOrder(values: readonly string[]): ShownOrder | undefined {
  let yearLast = false;
  let dayOnly = false;
  let monthOnly = false;
  for (const v of values) {
    if (!YEAR_LAST.test(trimSpace(v))) continue;
    const day = readDate(v, 'day') !== undefined;
    const month = readDate(v, 'month') !== undefined;
    yearLast ||= day || month;
    dayOnly ||= day && !month;
    monthOnly ||= month && !day;
  }
  if (!yearLast) return undefined;
  if (dayOnly === monthOnly) return 'either';
  return dayOnly ? 'day' : 'month';
}

/** The minutes of a real date and `time`, or undefined when the date is not real. */
function minutes(
  year: number,
  month: number,
  day: number,
  time: number,
): number | undefined {
  if (!isReal(year, month, day)) return undefined;
  return daysFromCivil(year, month, day) * DAY_MINUTES + time;
}

/**
 * The minutes into the day a time from `at` to `to` writes: a T, t or space,
 * HH:MM, an optional :SS with an optional fraction, then an optional Z or
 * ±HH:MM. Seconds stop at 59, so a leap second is not a time.
 */
function timeOfDay(v: string, at: number, to: number): number | undefined {
  const between = v.charCodeAt(at);
  if (between !== UPPER_T && between !== LOWER_T && between !== SPACE) {
    return undefined;
  }
  let i = at + 1;
  const hours = twoDigits(v, i);
  i += FIELD_DIGITS;
  if (v.charCodeAt(i++) !== COLON) return undefined;
  const mins = twoDigits(v, i);
  i += FIELD_DIGITS;
  if (hours < 0 || hours >= DAY_HOURS) return undefined;
  if (mins < 0 || mins >= HOUR_MINUTES) return undefined;
  if (v.charCodeAt(i) === COLON) {
    const secs = twoDigits(v, ++i);
    if (secs < 0 || secs >= MINUTE_SECONDS) return undefined;
    i += FIELD_DIGITS;
    if (v.charCodeAt(i) === POINT) {
      readDigits(v, ++i, to);
      if (digitsStop === i) return undefined;
      i = digitsStop;
    }
  }
  return offsetEnd(v, i) === to ? hours * HOUR_MINUTES + mins : undefined;
}

/**
 * The index past the offset at `i`: a Z, or ±HH:MM checked for form only, or
 * `i` itself when none is written. -1 when one is begun and not finished.
 */
function offsetEnd(v: string, i: number): number {
  const c = v.charCodeAt(i);
  if (c === UPPER_Z || c === LOWER_Z) return i + 1;
  if (c !== PLUS && c !== MINUS) return i;
  const colon = i + 1 + FIELD_DIGITS;
  const written =
    twoDigits(v, i + 1) >= 0 &&
    v.charCodeAt(colon) === COLON &&
    twoDigits(v, colon + 1) >= 0;
  return written ? colon + 1 + FIELD_DIGITS : -1;
}

/** The number two digits at `at` write, or -1 when either is not a digit. */
function twoDigits(v: string, at: number): number {
  const tens = v.charCodeAt(at);
  const ones = v.charCodeAt(at + 1);
  if (!isDigit(tens) || !isDigit(ones)) return -1;
  return (tens - ZERO) * DECIMAL + (ones - ZERO);
}

/**
 * Where the last readDigits stopped. A field's number and its end come from
 * one pass this way, with nothing allocated.
 */
let digitsStop = 0;

/** The number the digits from `from` write, stopping at `to` or a non-digit. */
function readDigits(v: string, from: number, to: number): number {
  let n = 0;
  let i = from;
  for (; i < to && isDigit(v.charCodeAt(i)); i++) {
    n = n * DECIMAL + (v.charCodeAt(i) - ZERO);
  }
  digitsStop = i;
  return n;
}

/** Whether `c` separates a date's fields: a hyphen, a slash or a full stop. */
function isSeparator(c: number): boolean {
  return c === MINUS || c === SLASH || c === POINT;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

/** Whether the character at `i` is White_Space, as `trimSpace` reads it. */
function spaceAt(v: string, i: number): boolean {
  const c = v.charCodeAt(i);
  if (c >= PRINTABLE_FIRST && c <= PRINTABLE_LAST) return false;
  return isSpace(v[i]!);
}

// Nov. 6, 1970 and November 6 1970; 6 Nov 1970 and 06-Nov-1970.
const NAME_FIRST = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/;
const DAY_FIRST = /^(\d{1,2})([ -])([A-Za-z]+)\.?\2(\d{4})$/;

// A month is its full name or its three-letter form, plus "sept".
const MONTH_NAMES = new Map<string, number>();
[
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
].forEach((name, i) => {
  MONTH_NAMES.set(name, i + 1);
  MONTH_NAMES.set(name.slice(0, 3), i + 1);
});
MONTH_NAMES.set('sept', MONTH_NAMES.get('september')!);

/**
 * A date with its month by name, in English, at midnight. These layouts are
 * rare in exports and keep their regular expressions.
 */
function named(s: string): number | undefined {
  const name = NAME_FIRST.exec(s);
  if (name !== null) {
    return minutes(Number(name[3]), month(name[1]!), Number(name[2]), 0);
  }
  const day = DAY_FIRST.exec(s);
  if (day === null) return undefined;
  return minutes(Number(day[4]), month(day[3]!), Number(day[1]), 0);
}

function month(name: string): number {
  return MONTH_NAMES.get(name.toLowerCase()) ?? 0;
}
