/**
 * @fileoverview textOf writes a Parquet date, time, timestamp or INT96 in
 * ISO 8601 at the precision it was stored at, ending in Z only where the
 * file says it counts from UTC.
 */

import type { SchemaElement, TimeUnit } from 'hyparquet/src/index.js';
import { expect, test } from 'vite-plus/test';

import { isDate } from '@sheet/kind';

import { textsOf } from './texts.ts';

const INT64_MAX = 2n ** 63n - 1n;

/** The days from 0000-01-01 to 1970-01-01. */
const DAYS_TO_1970 = 719528;

/** The day 10000-01-01, the first with a five-digit year. */
const YEAR_10000 = 2932897;

/** The days a Date holds on either side of 1970-01-01. */
const DATE_DAYS = 100_000_000;

/** A TIMESTAMP of unit, counted from UTC or not. */
function timestamp(unit: TimeUnit, utc: boolean): SchemaElement {
  return {
    name: 'x',
    type: 'INT64',
    logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: utc, unit },
  };
}

test('a DATE is YYYY-MM-DD, before 1970 as after it', () => {
  const values = [0, -1, -25567, -DAYS_TO_1970, 19782];
  expect(
    textsOf({ name: 'x', type: 'INT32', converted_type: 'DATE' }, values),
  ).toEqual([
    '1970-01-01',
    '1969-12-31',
    '1900-01-01',
    '0000-01-01',
    '2024-02-29',
  ]);
});

test('a DATE past year 9999 takes a sign, and one past a Date is its count', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'INT32',
    logical_type: { type: 'DATE' },
  };
  expect(textsOf(element, [YEAR_10000, DATE_DAYS + 1])).toEqual([
    '+010000-01-01',
    String(DATE_DAYS + 1),
  ]);
});

test('a timestamp keeps every digit its unit counts, and drops a zero fraction', () => {
  expect(textsOf(timestamp('MILLIS', true), [0n, 1700000000123n])).toEqual([
    '1970-01-01T00:00:00Z',
    '2023-11-14T22:13:20.123Z',
  ]);
  expect(textsOf(timestamp('MICROS', true), [1700000000000100n])).toEqual([
    '2023-11-14T22:13:20.000100Z',
  ]);
  expect(textsOf(timestamp('NANOS', true), [1500000000n])).toEqual([
    '1970-01-01T00:00:01.500000000Z',
  ]);
});

test('a timestamp before 1970 counts back from midnight', () => {
  expect(textsOf(timestamp('MILLIS', true), [-1n])).toEqual([
    '1969-12-31T23:59:59.999Z',
  ]);
  expect(textsOf(timestamp('MICROS', false), [-86400000001n])).toEqual([
    '1969-12-30T23:59:59.999999',
  ]);
});

test('a local timestamp has no Z, and isDate accepts a UTC one', () => {
  const count = 1700000000123456789n;
  const [local] = textsOf(timestamp('NANOS', false), [count]);
  const [utc] = textsOf(timestamp('NANOS', true), [count]);
  expect(local).toBe('2023-11-14T22:13:20.123456789');
  expect(utc).toBe('2023-11-14T22:13:20.123456789Z');
  expect(isDate(utc!)).toBe(true);
});

test('a timestamp past what a Date holds is its count', () => {
  expect(textsOf(timestamp('MILLIS', true), [INT64_MAX])).toEqual([
    String(INT64_MAX),
  ]);
});
