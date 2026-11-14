/**
 * @fileoverview A save keeps the fold of each chart over a file a path
 * points at, as its tally reads it, and the folds of a fixed workspace are
 * pinned to TALLY_VERSION, a formula column's among them.
 */

import { strFromU8, unzipSync } from 'fflate';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

import type { Chart, Plot } from '@document';
import type { Engine, SourceHandle, Tally } from '@engine';
import { hashOf } from '@engine/grown';
import { NO_ROW, Op } from '@sheet';
import { GroupsFold, SampleFold, TALLY_VERSION } from '@tally';
import { CHANNEL, REGION, REVENUE, UNITS } from '@core-tests/testdata/sales-q3';
import { FIXTURE, TINY, connect, indexed, openOne, sales } from './harness.ts';

const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });
/** Revenue in thousands, bound over the channel column. */
const THOUSANDS = 'revenue / 1000';
/** Revenue in thousands by region, rows per channel, and revenue by units. */
const PLOTS: Plot[] = [
  { t: 'bars', by: column(REGION), sum: column(CHANNEL) },
  { t: 'bars', by: column(REGION) },
  { t: 'scatter', x: column(UNITS), y: column(REVENUE) },
];
const encoder = new TextEncoder();

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** charts puts each plot over `source`, placed as a save writes a new chart. */
function charts(source: string): Chart[] {
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return PLOTS.map((plot, i) => {
    return { id: `c${i}`, source, plot, title: '', place, refresh: 0 };
  });
}

/** tallied resolves with each chart's complete tally over `src`, by id. */
function tallied(src: SourceHandle): Promise<Map<string, Tally>> {
  const heard = new Map<string, Tally>();
  return new Promise((resolve) => {
    src.onTally = (chart, tally) => {
      if (tally.t === 'unread' || !tally.coverage.complete) return;
      heard.set(chart, tally);
      if (heard.size === PLOTS.length) resolve(heard);
    };
  });
}

/**
 * charted opens a copy of the fixture in `engine`, binds THOUSANDS over
 * the channel column, charts it, waits for every chart, and saves it.
 */
async function charted(engine: Engine) {
  dir = await mkdtemp(join(tmpdir(), 'uno-tallied-'));
  const csv = join(dir, 'sales-q3.csv');
  await copyFile(FIXTURE, csv);
  const src = await openOne(engine, { name: 'sales-q3.csv', path: csv });
  await indexed(src);
  engine.mode(true);
  await src.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: THOUSANDS });
  const heard = tallied(src);
  for (const chart of charts(src.id)) await engine.chart(chart);
  const tallies = await heard;
  const at = join(dir, 'q3.uno');
  const uno = await engine.save({ source: src.id, cells: [], at }, 0);
  return { src, tallies, uno, at };
}

/** foldsIn reads the folds a save wrote of the charts over `source`. */
function foldsIn(uno: Uint8Array, source: string) {
  const entry = unzipSync(uno)[`cache/${source}/charts.json`]!;
  return JSON.parse(strFromU8(entry));
}

test('a save keeps the fold of each chart, which reads back as the tally the chart heard', async () => {
  const { engine, done } = connect(TINY);
  try {
    const { src, tallies, uno } = await charted(engine);
    const { version, charts: folds } = foldsIn(uno, src.id);
    expect(version).toBe(TALLY_VERSION);
    expect(Object.keys(folds)).toEqual(['c0', 'c1', 'c2']);
    for (const [id, tally] of tallies) {
      const { fold, rows } = folds[id];
      const back =
        tally.t === 'sample'
          ? SampleFold.restored(fold)!.snapshot()
          : GroupsFold.restored(fold)!.snapshot();
      expect(rows, id).toBe(tally.t === 'unread' ? 0 : tally.coverage.rows);
      expect({ ...tally, ...back }, id).toStrictEqual(tally);
    }
  } finally {
    done();
  }
});

/**
 * The hash of the folds TALLY_VERSION makes of the fixture's charts under
 * TINY, one of them over a bound formula column. It changes only with a
 * fold, how a cell reads as a number, or how a formula computes one, and
 * with it the version.
 */
const GOLDEN = {
  version: 1,
  charts: 'b32e25707dd7bea913942b17cceb086c67d8677d0115ed6509b80eac87970ab6',
};

test('the folds of a fixed workspace are as TALLY_VERSION says', async () => {
  const { engine, done } = connect(TINY);
  try {
    const { src, uno } = await charted(engine);
    const { charts: folds } = foldsIn(uno, src.id);
    expect(
      TALLY_VERSION,
      'a new TALLY_VERSION pins the hash its folds make with it',
    ).toBe(GOLDEN.version);
    expect(
      hashOf(encoder.encode(JSON.stringify(folds))),
      'a fold, how a cell reads as a number, or how a formula computes one, holds otherwise for the same file: bump TALLY_VERSION in core/src/tally/saved.ts and pin this hash with it',
    ).toBe(GOLDEN.charts);
  } finally {
    done();
  }
});
