/**
 * @fileoverview Tests for widening a schema. Columns a file names while it is
 * indexed go in after its data columns and before the columns the holder of
 * the rows supplies, which move right, so every logged edit stays on its
 * cell.
 */

import { describe, expect, test } from 'vite-plus/test';

import { Schema, namesBeside } from '@sheet';

const FILE = 3;

const HEADERS = ['region', 'units', 'double', '_file'];
const FILE_SHOWS = 'which file each row came from';
const ROWS = 3;

/** The two columns that arrive, and where _file sits once they have. */
const ARRIVING = ['city', 'zip'];
const FILE_WIDENED = FILE + ARRIVING.length;

function schema(): Schema {
  return new Schema(HEADERS, ROWS, [{ col: FILE, shows: FILE_SHOWS }]);
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

  test('leaves the headers and supplied columns it handed out as they were', () => {
    const s = schema();
    const { headers, supplied } = s;
    s.widen(ARRIVING);
    expect(headers).toEqual(HEADERS);
    expect(supplied).toEqual([{ col: FILE, shows: FILE_SHOWS }]);
  });
});
