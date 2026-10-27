/**
 * @fileoverview Measures the bytes fetched to tally charts over an object,
 * beside the index and after it.
 */

import { afterEach, expect, test } from 'vite-plus/test';

import type { Chart, Plot } from '@document';
import { TUNING } from '@engine';
import type { SourceHandle, Tally, Tuning } from '@engine';
import { Tallies } from '@engine/tally';
import { indexed, sales } from '@core-tests/engine/harness';
import { REGION, REVENUE, ROWS, UNITS } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
import type { Metric } from './record.ts';
import { remote, repeated } from './remote.ts';
import type { Remote } from './remote.ts';

/** Small chunks and blocks: the object is about 30 chunks and 600 blocks. */
const SMALL: Tuning = {
  ...TUNING,
  chunkBytes: 64 << 10,
  blockRows: 64,
  blockBytes: 4 << 10,
};
/** 1.9 MB. */
const REPEATS = 8;
const OBJECT = repeated(REPEATS);

/**
 * The most charts beside the index may fetch, index included, as a multiple
 * of the object. Of it, 0.1 is AHEAD - 1 chunks of SMALL.chunkBytes fetched
 * twice: the open's reads of SAMPLE_ROWS, four blocks of SMALL.blockRows,
 * push the index's stream out of the store's last REMEMBERED reads
 * (core/src/store/ahead.ts), and topUp drops the chunks held for it. A store
 * that keeps a reader while its held chunks are still wanted brings this to
 * about 1.08, and lowers the budget to 1.1 with it.
 */
const BESIDE_BUDGET = 1.2;
/** The most charts made after the index may fetch, as a multiple of the object. */
const AFTER_BUDGET = 1.05;

const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });
/** Rows per region, each region's share of the revenue, revenue against units. */
const PLOTS: Plot[] = [
  { t: 'bars', by: column(REGION) },
  { t: 'pie', by: column(REGION), sum: column(REVENUE) },
  { t: 'scatter', x: column(UNITS), y: column(REVENUE) },
];

/** charts puts each plot over `source`, placed as a save writes a new chart. */
function charts(source: string): Chart[] {
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return PLOTS.map((plot, i) => {
    return { id: `c${i}`, source, plot, title: '', place, refresh: 0 };
  });
}

/** pure folds every row of the object for `over`, as their complete tallies. */
function pure(over: readonly Chart[]): Tally[] {
  const tallies = new Tallies();
  for (const chart of over) tallies.attach(chart, HEADERS);
  const total = ROWS * REPEATS;
  const shown = (col: number) => (row: number) =>
    sales.display(row % ROWS, col);
  tallies.fold(0, 0, total, shown);
  return tallies.read(total, true).map(([, tally]) => tally);
}

/**
 * charted puts the charts over `src`, lets their reads through as they
 * come, and resolves with their complete tallies once every one is heard.
 */
async function charted(r: Remote, src: SourceHandle): Promise<Tally[]> {
  const over = charts(src.id);
  const last = new Map<string, Tally>();
  const heard = new Promise<void>((resolve) => {
    src.onTally = (chart, tally) => {
      if (tally.t !== 'unread' && !tally.coverage.complete) return;
      last.set(chart, tally);
      if (last.size === over.length) resolve();
    };
  });
  for (const chart of over) await r.engine.chart(chart);
  await r.door.during(heard);
  await r.door.quiet();
  return over.map((c) => last.get(c.id)!);
}

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

const metrics: Metric[] = [];

test('charts attached as the open answers fetch the object once, the blocks complete before they came and the chunks the read-ahead drops', async () => {
  r = await remote(OBJECT, SMALL);
  const door = r.door;
  // Reads are let through one at a time, lowest first, so the index is no
  // further than the open needed when the charts come.
  const src = await door.during(r.open(), () => door.letLowest());
  const tallies = await charted(r, src);
  expect(tallies).toStrictEqual(pure(charts(src.id)));
  const { requests, bytes } = door.since(0);
  const times = bytes / OBJECT.length;
  metrics.push(
    {
      name: 'charts beside index: bytes fetched per object byte',
      unit: 'x',
      value: times,
    },
    {
      name: 'charts beside index: requests',
      unit: 'requests',
      value: requests,
    },
  );
  expect(times).toBeLessThanOrEqual(BESIDE_BUDGET);
}, 60_000);

test('charts made after the index fetch the object once more', async () => {
  r = await remote(OBJECT, SMALL);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const from = r.door.asked.length;
  const tallies = await charted(r, src);
  expect(tallies).toStrictEqual(pure(charts(src.id)));
  const { requests, bytes } = r.door.since(from);
  const times = bytes / OBJECT.length;
  metrics.push(
    {
      name: 'charts after index: bytes fetched per object byte',
      unit: 'x',
      value: times,
    },
    { name: 'charts after index: requests', unit: 'requests', value: requests },
  );
  record('chart', metrics);
  expect(times).toBeLessThanOrEqual(AFTER_BUDGET);
}, 60_000);
