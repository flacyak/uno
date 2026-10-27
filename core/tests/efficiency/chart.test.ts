/**
 * @fileoverview Measures the bytes fetched to tally charts over an object
 * once the index is complete, when every block is read once more.
 */

import { afterEach, expect, test } from 'vite-plus/test';

import type { Chart, Plot } from '@document';
import { TUNING } from '@engine';
import type { SourceHandle, Tally, Tuning } from '@engine';
import { indexed, sales } from '@core-tests/engine/harness';
import { REGION, REVENUE, ROWS, UNITS } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
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
/** The coverage of a tally folded from every row of the object. */
const WHOLE = { rows: ROWS * REPEATS, total: ROWS * REPEATS, complete: true };

/** charts puts each plot over `source`, placed as a save writes a new chart. */
function charts(source: string): Chart[] {
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return PLOTS.map((plot, i) => {
    return { id: `c${i}`, source, plot, title: '', place, refresh: 0 };
  });
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

test('charts made after the index fetch the object once more', async () => {
  r = await remote(OBJECT, SMALL);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const from = r.door.asked.length;
  const tallies = await charted(r, src);
  expect(tallies).toMatchObject(PLOTS.map(() => ({ coverage: WHOLE })));
  const { requests, bytes } = r.door.since(from);
  const times = bytes / OBJECT.length;
  record('chart', [
    {
      name: 'charts after index: bytes fetched per object byte',
      unit: 'x',
      value: times,
    },
    { name: 'charts after index: requests', unit: 'requests', value: requests },
  ]);
  expect(times).toBeLessThanOrEqual(AFTER_BUDGET);
}, 60_000);
