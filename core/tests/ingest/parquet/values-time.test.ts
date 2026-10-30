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

test('a legacy TIMESTAMP_MILLIS or TIMESTAMP_MICROS counts from UTC', () => {
  expect(
    textsOf({ name: 'x', type: 'INT64', converted_type: 'TIMESTAMP_MICROS' }, [
      1n,
    ]),
  ).toEqual(['1970-01-01T00:00:00.000001Z']);
  expect(
    textsOf({ name: 'x', type: 'INT64', converted_type: 'TIMESTAMP_MILLIS' }, [
      1n,
    ]),
  ).toEqual(['1970-01-01T00:00:00.001Z']);
});

test('a timestamp past what a Date holds is its count', () => {
  expect(textsOf(timestamp('MILLIS', true), [INT64_MAX])).toEqual([
    String(INT64_MAX),
  ]);
});

/** The Julian day of 1970-01-01. */
const JULIAN_1970 = 2_440_588;

/** The bytes an INT96 takes, and where its Julian day starts in them. */
const INT96_BYTES = 12;
const INT96_DAY_AT = 8;

/** An INT96's stored bytes: the nanoseconds into its day, then its Julian day. */
function int96(nanos: bigint, day: number): Uint8Array {
  const bytes = new Uint8Array(INT96_BYTES);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, nanos, true);
  view.setInt32(INT96_DAY_AT, day, true);
  return bytes;
}

test('an INT96 is its Julian day and the nanoseconds into it, at nine digits', () => {
  const values = [
    int96(84690123456789n, JULIAN_1970 + 14288),
    int96(86399999999999n, JULIAN_1970 - 1),
    int96(1000000000n, JULIAN_1970),
  ];
  expect(textsOf({ name: 'x', type: 'INT96' }, values)).toEqual([
    '2009-02-13T23:31:30.123456789',
    '1969-12-31T23:59:59.999999999',
    '1970-01-01T00:00:01',
  ]);
});

test('an INT96 Spark wrote past 64 bits of microseconds reads as Spark was given it', () => {
  // Spark wrote 290000-12-30T23:00:00 from microseconds whose sum with the
  // epoch's Julian day wrapped, which left a negative day and nanoseconds.
  // A Date does not reach the year 290000, so it is its count.
  const overflowed = int96(-32509551616000n, -105862232);
  expect(textsOf({ name: 'x', type: 'INT96' }, [overflowed])).toEqual([
    '9089380393200000000000',
  ]);
});

test('a TIME is a clock, with Z where it is UTC', () => {
  expect(
    textsOf(
      { name: 'x', type: 'INT32', converted_type: 'TIME_MILLIS' },
      [45296789, 0],
    ),
  ).toEqual(['12:34:56.789Z', '00:00:00Z']);
  const local: SchemaElement = {
    name: 'x',
    type: 'INT64',
    logical_type: { type: 'TIME', isAdjustedToUTC: false, unit: 'MICROS' },
  };
  expect(textsOf(local, [86399999999n, 3600000000n])).toEqual([
    '23:59:59.999999',
    '01:00:00',
  ]);
});

test('a TIME outside one day is its count', () => {
  const element: SchemaElement = {
    name: 'x',
    type: 'INT64',
    logical_type: { type: 'TIME', isAdjustedToUTC: true, unit: 'NANOS' },
  };
  expect(textsOf(element, [-1n, 86400000000000n])).toEqual([
    '-1',
    '86400000000000',
  ]);
});
