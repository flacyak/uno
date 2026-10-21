/**
 * @fileoverview A Reading reads a source as the View read it before: a row
 * index reports the bytes it has scanned out of the file's size, a file
 * opened through openReading is held as itself and read as its spec says,
 * and every test file is named, started and labelled as openFormat does, or
 * refused by name where this build does not read it. A file a relink holds
 * to delimited text is refused when it holds another kind of rows.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vite-plus/test';

import { Refusal, RowIndex, TUNING } from '@engine';
import { openReading } from '@engine/reading';
import type { Expected, ReadSpec } from '@engine/reading';
import { labelOf, openFormat } from '@ingest';
import type { HeaderMode } from '@ingest';
import type { Said, Unread } from '@said';
import { bytesSource } from '@store';
import type { ByteSource } from '@store';
import { ROWS, bytes } from '@core-tests/testdata/sales-q3';
import { testdata } from './harness.ts';

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

test('held to delimited text, a file is split by its last extension, as when its log was made', async () => {
  // A spec holds no delimiter, so a reopen splits by the name as every build
  // before it did: q3.tsv.gz is not named a TSV, and a hidden .tsv is.
  const text = new TextEncoder().encode('a,b,c\n1,2,3\n');
  const columns = async (name: string): Promise<string[]> => {
    const reading = await openReading({
      name,
      source: bytesSource(text),
      spec: { kind: 'delimited', header: 'first' },
      header: 'first',
      tuning: TUNING,
    });
    return reading.columns().map((column) => column.name);
  };
  expect(await columns('q3.tsv.gz')).toEqual(['a', 'b', 'c']);
  expect(await columns('.tsv')).toEqual(['a,b,c']);
});

const TESTDATA = new URL('../testdata/', import.meta.url);

/** Every file in tests/testdata, whatever it holds. */
const FILES = readdirSync(TESTDATA, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

/** The test files this build does not read, and what each holds. */
const UNREAD: ReadonlyMap<string, Unread> = new Map([
  ['events.jsonl', 'JSON Lines'],
  ['sales-q3.csv.gz', 'gzip'],
  ['par1.bin', 'Parquet'],
]);

/** What a reader made of a file's head, or the message it failed with. */
type Seen =
  | { columns: readonly string[]; dataStart: number; label: Said }
  | { failed: string };

/** What `open` makes of a test file, or how it fails. */
function seen(name: string, open: (source: ByteSource) => Promise<Seen>) {
  const source = bytesSource(readFileSync(testdata(name)));
  return open(source).catch((err: unknown) => ({ failed: String(err) }));
}

/** How a test file that is refused with `said` is seen. */
function refused(said: Said): Seen {
  return { failed: String(new Refusal(said)) };
}

/** What openFormat makes of a test file. */
function formatted(name: string, header: HeaderMode): Promise<Seen> {
  return seen(name, async (source) => {
    const format = await openFormat(name, source, header);
    const { columns, dataStart } = format;
    return { columns, dataStart, label: labelOf(format) };
  });
}

/**
 * What openReading makes of a test file, read as `spec` says or detected and
 * held to what a relink `expect`s. Before its pass, the index has accounted
 * for the bytes ahead of the data.
 */
function read(name: string, spec?: ReadSpec, expect?: Expected): Promise<Seen> {
  return seen(name, async (source) => {
    const reading = await openReading({
      name,
      source,
      spec,
      expect,
      header: 'first',
      tuning: TUNING,
    });
    return {
      columns: reading.columns().map((column) => column.name),
      dataStart: reading.index.indexed().done,
      label: reading.label,
    };
  });
}

describe.each(FILES)('%s', (name) => {
  test.each<HeaderMode>(['first', 'none'])(
    'held to delimited text with header %s, reads as openFormat does',
    async (header) => {
      expect(await read(name, { kind: 'delimited', header })).toEqual(
        await formatted(name, header),
      );
    },
  );

  test('read fresh, reads as openFormat does or is refused by name', async () => {
    const what = UNREAD.get(name);
    expect(await read(name)).toEqual(
      what === undefined
        ? await formatted(name, 'first')
        : refused({ t: 'not-read', name, what }),
    );
  });
});

describe('a file a relink holds to delimited text', () => {
  const held: Expected = { name: 'sales.csv', kind: 'delimited' };

  /** The refusal's fields that the source and its log decide. */
  const RELINK = {
    t: 'relink-other-kind',
    name: held.name,
    was: held.kind,
  } as const;

  test('is refused as another kind of rows, ahead of what this build does not read', async () => {
    for (const [file, now] of [
      ['par1.bin', 'parquet'],
      ['events.jsonl', 'jsonl'],
    ] as const) {
      expect(await read(file, undefined, held)).toEqual(
        refused({ ...RELINK, file, now }),
      );
    }
  });

  test('reads as a fresh open does, and a compression is refused by name', async () => {
    const csv = 'sales-q3.csv';
    expect(await read(csv, undefined, held)).toEqual(await read(csv));
    const gz = 'sales-q3.csv.gz';
    expect(await read(gz, undefined, held)).toEqual(
      refused({ t: 'not-read', name: gz, what: 'gzip' }),
    );
  });
});
