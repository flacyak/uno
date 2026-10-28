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
/** Where city lands: the column _file held before it moved. */
const CITY = FILE;

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

/** Every operation, with a value and a row it can name. */
const OPS: Array<[Edit['op'], string, number]> = [
  [Op.Set, 'c.csv', 0],
  [Op.Note, 'x^2', 0],
  [Op.Apply, 'trim', NO_ROW],
  [Op.Bind, 'units * 2', NO_ROW],
  [Op.Unbind, '', NO_ROW],
];

function edit(
  op: Edit['op'],
  col: number,
  now: string,
  row: number = NO_ROW,
): Edit {
  return { seq: 0, op, row, col, now };
}

/**
 * undo takes back the last edit as View.undo does, by rebuilding the schema
 * from the edits before it over the schema's own columns.
 */
function undo(s: Schema): [Schema, Edit] {
  const edits = s.edits();
  const last = edits.pop()!;
  return [Schema.of(s.headers, s.rows, edits, s.supplied), last];
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

  test('refuses every edit to the supplied column where it moved, and takes one where it was', () => {
    const s = schema();
    s.widen(ARRIVING);
    const refusal = `edit 1: _file shows ${FILE_SHOWS}, so it cannot be changed`;
    for (const [op, now, row] of OPS) {
      expect(() => s.record(edit(op, FILE_WIDENED, now, row)), op).toThrow(
        refusal,
      );
    }
    expect(s.empty).toBe(true);
    s.record(edit(Op.Set, CITY, 'Hobart', 0));
    expect(s.writtenIn(0)?.get(CITY)?.now).toBe('Hobart');
  });

  test('undoes and redoes over the columns that arrived', () => {
    const s = schema();
    s.record(edit(Op.Bind, DOUBLE, 'units * 2'));
    s.widen(ARRIVING);
    s.record(edit(Op.Set, CITY, 'Hobart', 0));

    const [undone, last] = undo(s);
    expect(undone.headers).toEqual(s.headers);
    expect(undone.supplied).toEqual(s.supplied);
    expect(finishRows(undone, 0, WIDE, FILES)[0]!.shown).toEqual([
      'West',
      '4',
      '8',
      'Perth',
      '6000',
      'a.csv',
    ]);

    undone.record(last);
    expect(finishRows(undone, 0, WIDE, FILES)[0]!.shown).toEqual([
      'West',
      '4',
      '8',
      'Hobart',
      '6000',
      'a.csv',
    ]);

    // Back past the edit made before the widen, the columns stay.
    const [first] = undo(undo(undone)[0]);
    expect(first.empty).toBe(true);
    expect(first.headers).toEqual(s.headers);
    expect(finishRows(first, 0, WIDE, FILES)[0]!.shown).toEqual([
      'West',
      '4',
      '',
      'Perth',
      '6000',
      'a.csv',
    ]);
  });
});
