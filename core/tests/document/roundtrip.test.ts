/**
 * @fileoverview Random sources round-trip through writeDocument and
 * readContainer: what a source records of how it was read comes back as it
 * was held, for columns, kinds, partitions and row counts drawn from a schema
 * of uno.json's fields. A failure prints the smallest source that fails and
 * the seed that replays it.
 */

import { isDeepStrictEqual } from 'node:util';

import { Arbitrary, Effect, Schema } from 'effect';
import { expect, test } from 'vite-plus/test';

import { readContainer, writeDocument } from '@document';
import type { Held, HeldFile, HeldParts, SavedColumn } from '@document';
import { AT, workspace } from '@core-tests/document/manifest';

/** How many random workspaces each check writes and reads back. */
const RUNS = 200;
/** The seed every check draws from, so a failure replays. */
const SEED = 7;

/** A pinned column as uno.json holds it: a name, and a key where one is set. */
const Column = Schema.Struct({
  name: Schema.String,
  key: Schema.optionalKey(Schema.String),
});

/** What a source records of how its rows were read. */
const ReadAs = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(['jsonl', 'parquet'])),
  columns: Schema.optionalKey(Schema.Array(Column)),
});

/**
 * What a dataset's parts record: Hive keys, and each part's rows, counted or
 * not. A dataset has at least one part.
 */
const Dataset = Schema.Struct({
  partitions: Schema.optionalKey(Schema.Array(Schema.String)),
  rows: Schema.NonEmptyArray(Schema.UndefinedOr(Schema.Int)),
});

/** The bucket prefix a dataset's parts are under. */
const ROOT = 's3://lake/orders/';

/** A column as a source holds it, with its key only where one was drawn. */
function column({ name, key }: typeof Column.Type): SavedColumn {
  return key === undefined ? { name } : { name, key };
}

/** A pointed-at file that records `read` of how it was read. */
function file(read: typeof ReadAs.Type): HeldFile {
  return {
    id: 'events',
    name: 'events.jsonl',
    path: '/home/cpa/q4/exports/events.jsonl',
    bytes: 48_211_904,
    version: '"5e0c2a"',
    rows: 310_455,
    cols: 3,
    state: { active: { row: 0, col: 0 } },
    ...(read.kind === undefined ? {} : { kind: read.kind }),
    ...(read.columns === undefined
      ? {}
      : { columns: read.columns.map(column) }),
  };
}

/**
 * A dataset read in row space with one part per entry of `rows`, under
 * ROOT. Partition keys are made what a save accepts: named, and named once.
 */
function dataset(drawn: typeof Dataset.Type): HeldParts {
  const partitions = drawn.partitions;
  return {
    id: 'orders',
    name: 'orders',
    join: 'rows',
    root: ROOT,
    ...(partitions === undefined
      ? {}
      : { partitions: [...new Set(partitions)].filter((key) => key !== '') }),
    parts: drawn.rows.map((rows, i) => ({
      name: `part-${i}.parquet`,
      path: `${ROOT}year=2025/part-${i}.parquet`,
      bytes: 1_048_576,
      skip: 0,
      unterminated: false,
      ...(rows === undefined ? {} : { rows: Math.abs(rows) }),
    })),
    header: 'first',
    rows: 0,
    cols: 1,
    state: { active: { row: 0, col: 0 } },
  };
}

/** `value` without the keys that hold undefined, at every depth. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, withoutUndefined(v)]),
  );
}

/**
 * roundTrips says whether a workspace of `source` reads back as it was held.
 * A save or an open that refuses the source falsifies it too.
 */
function roundTrips(source: Held): boolean {
  try {
    const uno = writeDocument(workspace([source]));
    const back = readContainer('books.uno', uno, AT);
    return isDeepStrictEqual(
      withoutUndefined(back.sources),
      withoutUndefined([source]),
    );
  } catch {
    return false;
  }
}

/** checked runs `property` over RUNS values of `arbitrary`, and fails naming the smallest that falsified it. */
async function checked<A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean,
): Promise<void> {
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(arbitrary, property, { runs: RUNS, seed: SEED }),
  );
  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
  expect(result._tag).toBe('Passed');
}

test('a file source with any kind and any pinned columns reads back as it was held', () =>
  checked(Arbitrary.map(Arbitrary.schema(ReadAs), file), roundTrips));

test('a dataset with any partition keys and row counts reads back as it was held', () =>
  checked(Arbitrary.map(Arbitrary.schema(Dataset), dataset), roundTrips));
