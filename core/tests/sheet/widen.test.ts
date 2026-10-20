/**
 * @fileoverview Tests for widening a schema. Columns a file names while it is
 * indexed go in after its data columns and before the columns the holder of
 * the rows supplies, which move right, so every logged edit stays on its
 * cell.
 */

import { describe, expect, test } from 'vite-plus/test';

import { Schema } from '@sheet';

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

  test('leaves the headers and supplied columns it handed out as they were', () => {
    const s = schema();
    const { headers, supplied } = s;
    s.widen(ARRIVING);
    expect(headers).toEqual(HEADERS);
    expect(supplied).toEqual([{ col: FILE, shows: FILE_SHOWS }]);
  });
});
