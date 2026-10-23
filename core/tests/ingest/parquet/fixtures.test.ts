/**
 * @fileoverview Each Parquet fixture under tests/testdata is what
 * scripts/fixtures.ts writes, byte for byte.
 */

import { readFileSync } from 'node:fs';
import { expect, test } from 'vite-plus/test';

import { fixtures } from '../../../scripts/fixtures.ts';

const TESTDATA = new URL('../../testdata/', import.meta.url);

test('each Parquet fixture is what scripts/fixtures.ts writes', () => {
  for (const [path, bytes] of fixtures()) {
    expect(new Uint8Array(readFileSync(new URL(path, TESTDATA))), path).toEqual(
      bytes,
    );
  }
});

test('scripts/fixtures.ts writes the same bytes every time', () => {
  expect(fixtures()).toEqual(fixtures());
});
