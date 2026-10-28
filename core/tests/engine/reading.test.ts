/**
 * @fileoverview A Reading reads a source as the View read it before: a row
 * index reports the bytes it has scanned out of the file's size, and a file
 * opened through openReading is held as itself and read as its spec says.
 */

import { expect, test } from 'vite-plus/test';

import { RowIndex, TUNING } from '@engine';
import { openReading } from '@engine/reading';
import type { ReadSpec } from '@engine/reading';
import { bytesSource } from '@store';
import { ROWS, bytes } from '@core-tests/testdata/sales-q3';

test('a row index has indexed the bytes it has scanned, out of the size', () => {
  const index = new RowIndex(10, 1010, { blockRows: 2, blockBytes: 1 << 20 });
  // Before any scan, the bytes ahead of the first record are accounted for.
  expect(index.indexed()).toEqual({ done: 10, total: 1010 });

  for (const offset of [10, 20, 30]) index.begin(offset);
  index.scanned = 40;
  expect(index.indexed()).toEqual({ done: 40, total: 1010 });
});

test('a file is held as itself, read as its spec says and indexed to its end', async () => {
  const source = bytesSource(bytes);
  const spec: ReadSpec = { kind: 'delimited', header: 'none' };
  const reading = await openReading({
    name: 'sales-q3.csv',
    source,
    spec,
    header: 'first',
    tuning: TUNING,
  });
  expect(reading.behind).toEqual({ t: 'file', stored: source });
  expect(reading.spec()).toEqual(spec);

  await reading.pass(new AbortController().signal, () => undefined);
  const { size } = source;
  expect(reading.index.indexed()).toEqual({ done: size, total: size });
  // The header row is a row of its own.
  expect(reading.index.rows()).toBe(ROWS + 1);
  expect(await reading.runs(0)).toEqual([{ row: 0, part: 0 }]);
});
