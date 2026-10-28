/**
 * @fileoverview Tests for supplied columns, such as `_file` when several files
 * are read as one. The schema holds only each one's position and what it
 * shows; finishRows writes each row's supplied values into it.
 */

import { describe, expect, test } from 'vite-plus/test';

import { ERR_CELL, NO_ROW, Op, Schema, finishRows } from '@sheet';
import type { Edit } from '@sheet';

const UNITS = 1;
const DOUBLE = 2;
const FILE = 3;

const HEADERS = ['region', 'units', 'double', '_file'];

/** Source rows: one short, and one with extra fields. */
const SOURCES = [
  ['West', '4'],
  ['East', '5', '', 'left over', 'and more'],
  ['North'],
];

/** Each row's supplied values, one array shared by the rows of a file. */
const IN_A = ['a.csv'];
const IN_B = ['b.csv'];
const FILES = [IN_A, IN_A, IN_B];

const REFUSAL =
  'edit 1: _file shows which file each row came from, so it cannot be changed';

function schema(): Schema {
  return new Schema(HEADERS, SOURCES.length, [
    { col: FILE, shows: 'which file each row came from' },
  ]);
}

/** Two supplied columns, as a dataset's partition keys are. */
const STAMP = 2;
const YEAR = 3;
const MONTH = 4;
const PARTITIONED = ['region', 'units', 'stamp', 'year', 'month'];
const IN_JANUARY = ['2024', '1'];
const IN_FEBRUARY = ['2024', '2'];
const PARTITIONS = [IN_JANUARY, IN_JANUARY, IN_FEBRUARY];

/** Each partition column, and what an edit to it is refused with. */
const PARTITION_REFUSALS: ReadonlyArray<readonly [number, string]> = [
  [YEAR, 'edit 1: year shows the year in its path, so it cannot be changed'],
  [MONTH, 'edit 1: month shows the month in its path, so it cannot be changed'],
];

function partitioned(): Schema {
  return new Schema(PARTITIONED, SOURCES.length, [
    { col: YEAR, shows: 'the year in its path' },
    { col: MONTH, shows: 'the month in its path' },
  ]);
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

describe('a supplied column', () => {
  test('is filled in every row under an empty log, whatever the source has there', () => {
    const finished = finishRows(schema(), 0, SOURCES, FILES);
    expect(finished.map((f) => f.shown)).toEqual([
      ['West', '4', '', 'a.csv'],
      ['East', '5', '', 'a.csv'],
      ['North', '', '', 'b.csv'],
    ]);
    // raw and shown are the same array until a column is bound.
    for (const f of finished) expect(f.raw).toBe(f.shown);
  });

  test('stays what it was handed beside a typed cell and a formula', () => {
    const s = schema();
    s.record(edit(Op.Set, UNITS, '9', 2));
    s.record(edit(Op.Bind, DOUBLE, 'units * 2'));
    expect(finishRows(s, 0, SOURCES, FILES).map((f) => f.shown)).toEqual([
      ['West', '4', '8', 'a.csv'],
      ['East', '5', '10', 'a.csv'],
      ['North', '9', '18', 'b.csv'],
    ]);
  });

  test('can be named by a formula, which reads what it shows', () => {
    const s = schema();
    s.record(edit(Op.Bind, DOUBLE, '_file * 2'));
    // A file name is text, so every row is an error cell.
    expect(
      finishRows(s, 0, SOURCES, FILES).map((f) => f.shown[DOUBLE]),
    ).toEqual(SOURCES.map(() => ERR_CELL));
  });

  test('refuses every operation on it, and is left as it was', () => {
    const s = schema();
    for (const [op, now, row] of OPS) {
      expect(() => s.record(edit(op, FILE, now, row)), op).toThrow(REFUSAL);
    }
    expect(s.empty).toBe(true);
  });

  test('is not in a schema that was given none', () => {
    const plain = new Schema(HEADERS.slice(0, FILE), SOURCES.length);
    expect(finishRows(plain, 0, SOURCES, FILES).map((f) => f.shown)).toEqual(
      SOURCES,
    );
  });

  test('is refused anywhere but the last columns, in the order handed', () => {
    const shows = 'which file each row came from';
    const refusal = 'the supplied columns are not the last';
    expect(
      () => new Schema(HEADERS, SOURCES.length, [{ col: UNITS, shows }]),
    ).toThrow(refusal);
    expect(
      () =>
        new Schema(PARTITIONED, SOURCES.length, [
          { col: MONTH, shows },
          { col: YEAR, shows },
        ]),
    ).toThrow(refusal);
  });
});

describe('two supplied columns', () => {
  test('each refuse every operation, naming what each shows', () => {
    const s = partitioned();
    for (const [col, refusal] of PARTITION_REFUSALS) {
      for (const [op, now, row] of OPS) {
        expect(() => s.record(edit(op, col, now, row)), op).toThrow(refusal);
      }
    }
    expect(s.empty).toBe(true);
  });

  test('are each filled in and read by a formula, whatever the source has there', () => {
    const s = partitioned();
    s.record(edit(Op.Bind, STAMP, 'year * 100 + month'));
    expect(finishRows(s, 0, SOURCES, PARTITIONS).map((f) => f.shown)).toEqual([
      ['West', '4', '202401', '2024', '1'],
      ['East', '5', '202401', '2024', '1'],
      ['North', '', '202402', '2024', '2'],
    ]);
  });
});
