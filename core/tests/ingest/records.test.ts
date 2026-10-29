/**
 * @fileoverview Delimited text read as records agrees with its Format: the
 * columns, where the data starts, the label, each record's first byte and the
 * rows a run of records decodes to.
 */

import { expect, test } from 'vite-plus/test';

import { delimitedRecords, labelOf, openFormat } from '@ingest';
import type { Scanner } from '@ingest';
import { blobSource } from '@store';

const encoder = new TextEncoder();

/** A header, a quoted field across lines and a blank line. */
const TEXT = 'name;role\n"Okafor\nAda";lead\n\nLi;ops\n';

/** The offsets a scanner reports over all of `bytes`. */
function starts(scanner: (begin: (at: number) => void) => Scanner): number[] {
  const found: number[] = [];
  scanner((at) => found.push(at)).push(encoder.encode(TEXT), 0);
  return found;
}

test('delimited text read as records reads as its Format does', async () => {
  const format = await openFormat(
    'staff.csv',
    blobSource(new Blob([TEXT])),
    'none',
  );
  const records = delimitedRecords(format);

  expect(records.columns()).toEqual([
    { name: 'column_1' },
    { name: 'column_2' },
  ]);
  expect(records.dataStart).toBe(format.dataStart);
  expect(records.label()).toEqual(labelOf(format));
  expect(starts((begin) => records.scanner(begin))).toEqual(
    starts((begin) => format.scanner(begin)),
  );
  expect(starts((begin) => records.indexer(begin))).toEqual(
    starts((begin) => format.scanner(begin)),
  );
  const bytes = encoder.encode(TEXT);
  expect(records.decode(bytes)).toEqual(format.decode(bytes));
});
