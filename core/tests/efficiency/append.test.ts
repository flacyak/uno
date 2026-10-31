/**
 * @fileoverview Measures the requests and bytes an append of one file to an
 * indexed source of several files in a bucket asks for, with a chart over
 * the source and without.
 */

import { afterEach, expect, test } from 'vite-plus/test';

import type { Chart } from '@document';
import { TUNING } from '@engine';
import type { SourceHandle } from '@engine';
import type { SingleRef } from '@store';
import { indexed, openOne, sales } from '@core-tests/engine/harness';
import { BUCKET } from '@core-tests/store/standin';
import { REGION, ROWS } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
import type { Metric } from './record.ts';
import { repeated, served } from './remote.ts';
import type { Served } from './remote.ts';

/** 2.4 MB and 48,120 rows in every file. */
const REPEATS = 10;
const FILE = repeated(REPEATS);

/** How many files the source opens with, before one more is appended. */
const OPENED = 3;

/** The most requests an append may send. */
const REQUESTS_BUDGET = 13;
/**
 * The most bytes an append may ask for: the new file, the heads of the files
 * it opens, and the blocks it reads for the columns and to index again.
 */
const BYTES_BUDGET = 2_800_000;

/**
 * The most an append beside a chart may send and ask for: one request more,
 * of the last block the source had, 50,040 bytes of TUNING.blockRows rows,
 * which the chart's fold gives back so the appended rows fold on from the
 * rows kept. Nothing else is read of the rows kept.
 */
const CHARTED_REQUESTS_BUDGET = REQUESTS_BUDGET + 1;
const CHARTED_BYTES_BUDGET = 2_850_000;

/** Where the files are in the bucket. */
const FOLDER = 'exports';

/** Rows per region over `source`, placed as a save writes a new chart. */
function chart(source: string): Chart {
  const by = { col: REGION, header: sales.columns[REGION]!.header };
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return {
    id: 'c1',
    source,
    plot: { t: 'bars', by },
    title: '',
    place,
    refresh: 0,
  };
}

/** complete resolves once the chart over `src` has heard its complete tally. */
function complete(src: SourceHandle): Promise<void> {
  return new Promise((resolve) => {
    src.onTally = (_, tally) => {
      if (tally.t !== 'unread' && tally.coverage.complete) resolve();
    };
  });
}

let s: Served | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const metrics: Metric[] = [];

/** opened serves OPENED + 1 files, and opens a source over the first OPENED, indexed and quiet. */
async function opened(): Promise<
  Served & { files: SingleRef[]; before: SourceHandle }
> {
  const files = Array.from({ length: OPENED + 1 }, (_, i): SingleRef => {
    const name = `export-${i + 1}.csv`;
    return { name, path: `s3://${BUCKET}/${FOLDER}/${name}` };
  });
  const objects = files.map((f) => [`${FOLDER}/${f.name}`, FILE] as const);
  s = await served(new Map(objects), TUNING);
  const door = s.door;
  const parts = files.slice(0, OPENED).map((ref) => ({ ref }));
  const before = await door.during(
    openOne(s.engine, { name: FOLDER, parts, header: 'first' }),
  );
  await door.during(indexed(before));
  await door.quiet();
  return { ...s, files, before };
}

test('appending a file to a source of several files reads the new file and little else', async () => {
  const { door, engine, files, before } = await opened();

  const from = door.asked.length;
  const src = await door.during(engine.append(before, [files[OPENED]!]));
  await door.during(indexed(src));
  await door.quiet();
  expect(src.progress.rows).toBe(ROWS * REPEATS * files.length);

  const { requests, bytes } = door.since(from);
  metrics.push(
    { name: 'append: requests', unit: 'requests', value: requests },
    { name: 'append: bytes asked for', unit: 'bytes', value: bytes },
  );
  expect(requests).toBeLessThanOrEqual(REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(BYTES_BUDGET);
}, 60_000);

test('appending a file to a source of several files a chart reads fetches the new file and one block more, and nothing else of the rows kept', async () => {
  const { door, engine, files, before } = await opened();
  const tallied = complete(before);
  await engine.chart(chart(before.id));
  await door.during(tallied);
  await door.quiet();

  const from = door.asked.length;
  const src = await door.during(engine.append(before, [files[OPENED]!]));
  await door.during(complete(src));
  await door.quiet();

  const { requests, bytes } = door.since(from);
  metrics.push(
    {
      name: 'append beside a chart: requests',
      unit: 'requests',
      value: requests,
    },
    {
      name: 'append beside a chart: bytes asked for',
      unit: 'bytes',
      value: bytes,
    },
  );
  record('append', metrics);
  expect(requests).toBeLessThanOrEqual(CHARTED_REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(CHARTED_BYTES_BUDGET);
}, 60_000);
