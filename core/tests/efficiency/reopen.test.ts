/**
 * @fileoverview Measures what a reopen of a saved workspace reads of the
 * source it points at, a file on disk and an object in a bucket: with no
 * chart, until its index is complete, and with a bars and a scatter chart,
 * until both are complete too.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import type { Chart, Plot } from '@document';
import { TUNING } from '@engine';
import type { Engine, SourceHandle, Tuning } from '@engine';
import { blobProvider } from '@store';
import { diskProvider } from '@store/node';
import {
  connect,
  counted,
  indexed,
  openOne,
  sales,
} from '@core-tests/engine/harness';
import { BUCKET } from '@core-tests/store/standin';
import { REGION, REVENUE, UNITS } from '@core-tests/testdata/sales-q3';
import { record } from './record.ts';
import type { Metric } from './record.ts';
import { remote, repeated } from './remote.ts';
import type { Asked, Remote } from './remote.ts';

/**
 * Small chunks, so the 1.9 MB object is about 30 of them, as a large file is
 * many. Its blocks are TUNING's, 38 of 1,024 rows.
 */
const SMALL: Tuning = { ...TUNING, chunkBytes: 64 << 10 };
/** 1.9 MB. */
const REPEATS = 8;
const OBJECT = repeated(REPEATS);

/**
 * The least a reopen reads today, as a multiple of the source: all of it,
 * again, whether a chart reads it or not. A save keeps no index, so the
 * reopen indexes the source as the first open did.
 */
const WHOLE_AGAIN = 1;

const HEADERS = sales.columns.map((c) => c.header);
/** The fixture's column `col`, as a chart names it. */
const column = (col: number) => ({ col, header: HEADERS[col]! });
/** Rows per region, and revenue against units. */
const PLOTS: Plot[] = [
  { t: 'bars', by: column(REGION) },
  { t: 'scatter', x: column(UNITS), y: column(REVENUE) },
];

/** charts puts each plot over `source`, placed as a save writes a new chart. */
function charts(source: string): Chart[] {
  const place = { x: 1, y: 0, width: 420, height: 260 };
  return PLOTS.map((plot, i) => {
    return { id: `c${i}`, source, plot, title: '', place, refresh: 0 };
  });
}

/** tallied resolves once every chart over `src` has heard a complete tally. */
function tallied(src: SourceHandle, count: number): Promise<void> {
  const heard = new Set<string>();
  return new Promise((resolve) => {
    src.onTally = (chart, tally) => {
      if (tally.t === 'unread' || !tally.coverage.complete) return;
      heard.add(chart);
      if (heard.size === count) resolve();
    };
  });
}

/** Cost is what a reopen asked of its source. */
interface Cost {
  requests: number;
  bytes: number;
}

/**
 * Where is a place the source is read from: an engine to open it with, what
 * it has asked of the source, and a wait that lets the reads through.
 */
interface Where {
  path: string;
  engine(): Engine;
  asked: readonly Asked[];
  during<T>(work: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let dir: string | undefined;
let place: Where | undefined;
afterEach(async () => {
  await place?.close();
  place = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** onDisk writes the source to `dir` and reads it through a counted disk. */
async function onDisk(at: string): Promise<Where> {
  const path = join(at, 'big.csv');
  await writeFile(path, OBJECT);
  const asked: Asked[] = [];
  const providers = [counted(diskProvider(), path, asked), blobProvider()];
  const done: Array<() => void> = [];
  return {
    path,
    asked,
    engine() {
      const c = connect(SMALL, providers);
      done.push(c.done);
      return c.engine;
    },
    during: (work) => work,
    close() {
      for (const d of done) d();
      return Promise.resolve();
    },
  };
}

/** inBucket serves the source from the stand-in bucket behind its Door. */
async function inBucket(): Promise<Where> {
  const r: Remote = await remote(OBJECT, SMALL);
  let first = true;
  return {
    path: `s3://${BUCKET}/2025/big.csv`,
    asked: r.door.asked,
    engine() {
      if (!first) return r.another();
      first = false;
      return r.engine;
    },
    async during(work) {
      const out = await r.door.during(work);
      await r.door.quiet();
      return out;
    },
    close: () => r.close(),
  };
}

/**
 * reopened opens the source in one engine, indexes it, charts it with
 * `plots` charts, saves the workspace next to it, and opens the save in a
 * second engine. It returns what the second engine asked of the source
 * until its index and every chart were complete.
 */
async function reopened(where: Where, plots: number): Promise<Cost> {
  const first = where.engine();
  const src = await where.during(
    openOne(first, { name: 'big.csv', path: where.path }),
  );
  await where.during(indexed(src));
  const over = charts(src.id).slice(0, plots);
  const drawn = tallied(src, over.length);
  for (const chart of over) await first.chart(chart);
  if (over.length > 0) await where.during(drawn);
  const uno = join(dir!, 'big.uno');
  const saved = await first.save({ source: src.id, cells: [], at: uno }, 0);
  await writeFile(uno, saved);

  const from = where.asked.length;
  const again = await where.during(
    openOne(where.engine(), { name: 'big.uno', path: uno }),
  );
  const drawnAgain = tallied(again, over.length);
  await where.during(indexed(again));
  if (over.length > 0) await where.during(drawnAgain);
  const sent = where.asked.slice(from);
  return {
    requests: sent.length,
    bytes: sent.reduce((sum, a) => sum + a.length, 0),
  };
}

const metrics: Metric[] = [];

/** measured notes a reopen's cost under `name` and returns it per source byte. */
function measured(name: string, cost: Cost): number {
  const times = cost.bytes / OBJECT.length;
  metrics.push(
    { name: `${name}: bytes read per source byte`, unit: 'x', value: times },
    { name: `${name}: requests`, unit: 'requests', value: cost.requests },
  );
  return times;
}

const PLACES = [
  { where: 'disk', open: (at: string) => onDisk(at) },
  { where: 'bucket', open: () => inBucket() },
] as const;

for (const { where, open } of PLACES) {
  test(`a reopen over a file in a ${where} with no chart reads it whole again`, async () => {
    dir = await mkdtemp(join(tmpdir(), 'uno-reopen-'));
    place = await open(dir);
    const times = measured(`reopen, ${where}`, await reopened(place, 0));
    expect(times).toBeGreaterThanOrEqual(WHOLE_AGAIN);
  }, 60_000);

  test(`a reopen over a file in a ${where} with a bars and a scatter chart reads it whole again`, async () => {
    dir = await mkdtemp(join(tmpdir(), 'uno-reopen-'));
    place = await open(dir);
    const cost = await reopened(place, PLOTS.length);
    const times = measured(`reopen with charts, ${where}`, cost);
    record('reopen', metrics);
    expect(times).toBeGreaterThanOrEqual(WHOLE_AGAIN);
  }, 60_000);
}
