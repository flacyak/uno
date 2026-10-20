/**
 * @fileoverview Tests for widening a schema. Columns a file names while it is
 * indexed go in after its data columns and before the columns the holder of
 * the rows supplies, which move right, so every logged edit stays on its
 * cell.
 */

import { describe, expect, test } from 'vite-plus/test';

import { NO_ROW, Op, Schema, finishRows, namesBeside } from '@sheet';
import type { Edit } from '@sheet';

const REGION = 0;
const UNITS = 1;
const DOUBLE = 2;
const FILE = 3;

const HEADERS = ['region', 'units', 'double', '_file'];
const FILE_SHOWS = 'which file each row came from';

/** The two columns that arrive, and where _file sits once they have. */
const ARRIVING = ['city', 'zip'];
const FILE_WIDENED = FILE + ARRIVING.length;

/** Each row as the source holds it before city and zip arrive. */
const NARROW = [
  ['West', '4'],
  ['East', '5'],
  ['North', '6'],
];

/** The same rows once the source has named city and zip. */
const WIDE = [
  ['West', '4', '', 'Perth', '6000'],
  ['East', '5', '', 'Sydney', '2000'],
  ['North', '6', '', 'Darwin', '0800'],
];

/** Each row's supplied values, one array shared by the rows of a file. */
const IN_A = ['a.csv'];
const IN_B = ['b.csv'];
const FILES = [IN_A, IN_A, IN_B];

const ROWS = NARROW.length;

function schema(): Schema {
  return new Schema(HEADERS, ROWS, [{ col: FILE, shows: FILE_SHOWS }]);
}

function edit(
  op: Edit['op'],
  col: number,
  now: string,
  row: number = NO_ROW,
): Edit {
  return { seq: 0, op, row, col, now };
}

describe('a widened schema', () => {
  test('adds data columns before the supplied ones, which move right', () => {
    const s = schema();
    s.widen(ARRIVING);
    expect(s.headers).toEqual([
      'region',
      'units',
      'double',
      'city',
      'zip',
      '_file',
    ]);
    expect(s.supplied).toEqual([{ col: FILE_WIDENED, shows: FILE_SHOWS }]);
    expect(s.indexOf('city')).toBe(FILE);
    expect(s.indexOf('_file')).toBe(FILE_WIDENED);
  });

  test('adds them at the end when it supplies none', () => {
    const s = new Schema(HEADERS.slice(0, FILE), ROWS);
    s.widen(ARRIVING);
    expect(s.headers).toEqual(['region', 'units', 'double', 'city', 'zip']);
    expect(s.indexOf('zip')).toBe(FILE + 1);
  });

  test('suffixes a new name a column already has, and keeps every old one', () => {
    const s = schema();
    s.widen(['_file', 'units', 'city', 'city', 'units_2']);
    expect(s.headers).toEqual([
      ...HEADERS.slice(0, FILE),
      '_file_2',
      'units_3',
      'city',
      'city_2',
      'units_2',
      '_file',
    ]);
    s.widen(['_file']);
    expect(s.headers.at(-2)).toBe('_file_3');
    expect(s.headers.at(-1)).toBe('_file');
    expect(s.supplied[0]!.col).toBe(s.headers.length - 1);
  });

  test('names what arrives by the rule a header row is named by', () => {
    // A header row is named beside nothing: the first of each name keeps it.
    expect(namesBeside([], ['a', 'a', 'a_2', 'b', 'a'])).toEqual([
      'a',
      'a_3',
      'a_2',
      'b',
      'a_4',
    ]);
    // Beside kept columns, every name one of them has takes a suffix.
    expect(namesBeside(['a', 'a_2'], ['a', 'b', 'a', 'b'])).toEqual([
      'a_3',
      'b',
      'a_4',
      'b_2',
    ]);
  });

  test('keeps every logged edit on its cell', () => {
    const s = schema();
    s.record(edit(Op.Set, REGION, 'Westside', 0));
    s.record(edit(Op.Set, UNITS, '9', 2));
    s.record(edit(Op.Bind, DOUBLE, 'units * 2'));
    const logged = s.edits();
    const before = finishRows(s, 0, NARROW, FILES).map((f) => f.shown);

    s.widen(ARRIVING);
    expect(s.logEquals(logged)).toBe(true);
    const after = finishRows(s, 0, WIDE, FILES).map((f) => f.shown);
    expect(after).toEqual([
      ['Westside', '4', '8', 'Perth', '6000', 'a.csv'],
      ['East', '5', '10', 'Sydney', '2000', 'a.csv'],
      ['North', '9', '18', 'Darwin', '0800', 'b.csv'],
    ]);
    // Without the columns that arrived, each row is the row it was.
    expect(after.map((row) => row.toSpliced(FILE, ARRIVING.length))).toEqual(
      before,
    );
  });

  test('keeps a formula naming _file on the column it supplies', () => {
    // Files named as numbers, so what the formula shows says which column
    // it read.
    const years = [['2023'], ['2023'], ['2024']];
    const s = schema();
    s.record(edit(Op.Bind, DOUBLE, '_file + 1'));
    s.widen(['_file']);
    // The _file that arrives is named _file_2 and holds 7 in every row.
    const sources = NARROW.map((row) => [...row, '', '7']);
    const shown = finishRows(s, 0, sources, years).map((f) => f.shown);
    expect(shown.map((row) => row[DOUBLE])).toEqual(['2024', '2024', '2025']);
    expect(shown.map((row) => row[FILE])).toEqual(['7', '7', '7']);
    expect(s.computedColumns()).toEqual([DOUBLE]);
  });

  test('leaves the headers and supplied columns it handed out as they were', () => {
    const s = schema();
    const { headers, supplied } = s;
    s.widen(ARRIVING);
    expect(headers).toEqual(HEADERS);
    expect(supplied).toEqual([{ col: FILE, shows: FILE_SHOWS }]);
  });
});
