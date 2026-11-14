/**
 * @fileoverview A save keeps the fold of each chart over a file a path
 * points at, as its tally reads it, and the folds of a fixed workspace are
 * pinned to TALLY_VERSION, a formula column's among them. A reopen whose
 * edits and fold version match draws each chart complete without a pass.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vite-plus/test';

import { LOG_ENTRY } from '@document';
import type { Chart, Plot } from '@document';
import type { Engine, SourceHandle, Tally } from '@engine';
import { hashOf } from '@engine/grown';
import { NO_ROW, Op } from '@sheet';
import { GroupsFold, SampleFold, TALLY_VERSION } from '@tally';
import { CHANNEL, REGION, REVENUE, UNITS } from '@core-tests/testdata/sales-q3';
import { blobProvider } from '@store';
import { diskProvider } from '@store/node';
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  counted,
  indexed,
  openOne,
  sales,
} from './harness.ts';

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

/** Asked is what a reopen read of the source. */
type Asked = Array<{ offset: number | undefined; length: number }>;

/**
 * reopened saves the charted fixture, changes the save by `change`, and
 * reopens it in a second engine, which reads the file through a counted
 * disk. It returns the tallies each engine heard, and what the second read.
 */
async function reopened(
  change: (entries: Record<string, Uint8Array>, source: string) => void,
) {
  const first = connect(TINY);
  const asked: Asked = [];
  try {
    const { src, tallies, uno, at } = await charted(first.engine);
    const entries = unzipSync(uno);
    change(entries, src.id);
    await writeFile(at, zipSync(entries));
    const csv = join(dir!, 'sales-q3.csv');
    const again = connect(TINY, [
      counted(diskProvider(), csv, asked),
      blobProvider(),
    ]);
    try {
      const back = await openOne(again.engine, { name: 'q3.uno', path: at });
      const heard = tallied(back);
      return { tallies, again: await heard, asked };
    } finally {
      again.done();
    }
  } finally {
    first.done();
  }
}

/**
 * The most of the fixture a reopen with every chart drawn reads: the sniff
 * and the rows the columns are told from, 75,637 of 240,435 bytes under
 * TINY. A pass for the charts reads the whole file.
 */
const UNCHARTED_SHARE = 0.5;

/** share is how much of the fixture `asked` read. */
const share = (asked: Asked) =>
  asked.reduce((sum, a) => sum + a.length, 0) / bytes.length;

test('a reopen whose edits and fold version match draws each chart complete without a pass, as it was', async () => {
  const { tallies, again, asked } = await reopened(() => undefined);
  expect(again).toStrictEqual(tallies);
  expect(share(asked)).toBeLessThan(UNCHARTED_SHARE);
});

test('a reopen over edits an older build added to the log folds every chart again', async () => {
  const { tallies, again, asked } = await reopened((entries) => {
    // A build that carries cache/ whole adds an edit in its save.
    const log = strFromU8(entries[LOG_ENTRY]!);
    const bind = JSON.parse(log.split('\n')[0]!);
    const set = { ...bind, seq: 2, op: Op.Set, row: 0, col: REGION };
    const edit = { ...set, was: 'West', now: 'Atlantis' };
    entries[LOG_ENTRY] = strToU8(`${log}${JSON.stringify(edit)}\n`);
  });
  expect(share(asked), 'the charts read the file').toBeGreaterThan(1);
  const values = (t?: Tally) =>
    t?.t === 'groups' ? t.groups.map((g) => g.value) : [];
  expect(values(again.get('c1'))).toContain('Atlantis');
  expect(values(tallies.get('c1'))).not.toContain('Atlantis');
});

test('a chart whose fold read a column with another decimal mark folds again, and the others keep theirs', async () => {
  const { tallies, again } = await reopened((entries, source) => {
    const name = `cache/${source}/charts.json`;
    const saved = JSON.parse(strFromU8(entries[name]!));
    saved.charts.c0.fold.mark = 'comma';
    // A mark the scatter's fold keeps shows it was not folded again.
    saved.charts.c2.fold.plotted += 1;
    entries[name] = strToU8(JSON.stringify(saved));
  });
  expect(again.get('c0')).toStrictEqual(tallies.get('c0'));
  const plotted = (t?: Tally) => (t?.t === 'sample' ? t.plotted : 0);
  expect(plotted(again.get('c2'))).toBe(plotted(tallies.get('c2')) + 1);
});
