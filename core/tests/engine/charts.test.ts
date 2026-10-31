/**
 * @fileoverview A workspace's charts in the engine: the open of a .uno hands
 * them over, a request adds, replaces or removes one, a save writes them
 * back, and each goes with its source.
 */

import { unzipSync } from 'fflate';
import { expect, test } from 'vite-plus/test';

import {
  CHARTS_AT_MOST,
  CHARTS_ENTRY,
  CHARTS_VERSION,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  STATE_ENTRY,
  newManifest,
  readContainer,
  writeDocument,
} from '@document';
import type { CarriedChart, Chart } from '@document';
import type { Engine } from '@engine';
import { blobProvider } from '@store';
import { COLS, REGION, ROWS } from '@core-tests/testdata/sales-q3';
import { FIXTURE, connect } from './harness.ts';

/** A save's bound on carried bytes. Every source is read from the disk. */
const CARRIES_NOTHING = 0;

/** The fixture as a source of the workspace, by its path. */
const SALES = {
  name: 'sales-q3.csv',
  path: FIXTURE,
  rows: ROWS,
  cols: COLS,
  state: { active: { row: 0, col: 0 } },
};

/** Rows per region of the north source, placed as a save writes it. */
const NORTH: Chart = {
  id: 'c1',
  source: 'north',
  plot: { t: 'bars', by: { col: REGION, header: 'region' } },
  title: '',
  place: { x: 1, y: 0, width: 420, height: 260 },
  refresh: 0,
};

/** The same chart over the south source. */
const SOUTH: Chart = { ...NORTH, id: 'c2', source: 'south' };

/** A newer build's chart over `source`, as this build carries it. */
function newer(source: string): CarriedChart {
  const id = 'c3';
  const json = `{"id":"${id}","source":"${source}","plot":{"t":"line"}}`;
  return { id, source, json };
}

/** opened opens a .uno of a north and a south source holding `charts`,
 * `carried`, and the entries in `extra`. */
function opened(
  engine: Engine,
  charts: Chart[],
  carried: CarriedChart[] = [],
  extra = new Map<string, Uint8Array>(),
) {
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [
      { ...SALES, id: 'north' },
      { ...SALES, id: 'south' },
    ],
    active: 'north',
    log: [],
    charts,
    carriedCharts: carried,
    extra,
    at: '',
  });
  return engine.open({ name: 'q3.uno', blob: new Blob([new Uint8Array(uno)]) });
}

/** saved saves the workspace. */
function saved(engine: Engine): Promise<Uint8Array> {
  const place = { source: 'north', cells: [], at: '' };
  return engine.save(place, CARRIES_NOTHING);
}

test("an open hands over a .uno's charts, oldest first, and a file's none", async () => {
  const { engine, done } = connect();
  try {
    const added = await opened(engine, [NORTH, SOUTH]);
    expect(added.charts).toStrictEqual([NORTH, SOUTH]);
    expect(added.chartsNote).toBeUndefined();

    const file = await engine.open({ name: 'sales-q3.csv', path: FIXTURE });
    expect(file.charts).toStrictEqual([]);
    expect(file.chartsNote).toBeUndefined();
  } finally {
    done();
  }
});

test('an open says how many charts it keeps that it cannot show', async () => {
  const { engine, done } = connect();
  try {
    // A repeated id, a newer build's chart, and one that names no source.
    const repeated = { ...SOUTH, id: NORTH.id };
    const carried = [newer('north'), newer('')];
    const added = await opened(engine, [NORTH, repeated], carried);
    expect(added.chartsNote).toStrictEqual({ t: 'charts-kept', count: 3 });
  } finally {
    done();
  }
});

test('a source that opens as missing keeps its charts', async () => {
  // With no disk to read from, each source of the .uno opens as missing.
  const { engine, done } = connect(undefined, [blobProvider()]);
  try {
    const added = await opened(engine, [NORTH, SOUTH]);
    for (const s of added.sources) expect(s.opened.link?.missing).toBeDefined();
    expect(added.charts).toStrictEqual([NORTH, SOUTH]);

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([NORTH, SOUTH]);
  } finally {
    done();
  }
});

test("a .uno's charts come back from a save as the .uno held them", async () => {
  const { engine, done } = connect();
  try {
    // A repeated id is carried, so it takes no chart's place.
    const repeated = { ...SOUTH, id: NORTH.id };
    const charts = [NORTH, SOUTH, repeated];
    const added = await opened(engine, charts, [newer('north')]);
    expect(added.charts).toStrictEqual([NORTH, SOUTH]);

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual(charts);
    expect(back.carriedCharts).toStrictEqual([newer('north')]);
  } finally {
    done();
  }
});

test('a chart over a source the .uno does not hold is left out, and the open says so', async () => {
  const { engine, done } = connect();
  try {
    // A build before charts removed the west source, and kept its charts.
    // A carried chart that names no source has none to lose.
    const west = { ...SOUTH, source: 'west' };
    const carried = [newer('west'), newer('')];
    const added = await opened(engine, [NORTH, west], carried);
    expect(added.charts).toStrictEqual([NORTH]);
    // The two left out are gone from the next save, and the one kept is
    // not, so the note counts the two.
    expect(added.chartsNote).toStrictEqual({ t: 'charts-left-out', count: 2 });

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([NORTH]);
    expect(back.carriedCharts).toStrictEqual([newer('')]);
  } finally {
    done();
  }
});

test('a removed source takes its charts with it', async () => {
  const { engine, done } = connect();
  try {
    const carried = [newer('north'), newer('south')];
    const { sources } = await opened(engine, [NORTH, SOUTH], carried);
    await engine.remove(sources[1]!);

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([NORTH]);
    expect(back.carriedCharts).toStrictEqual([newer('north')]);
  } finally {
    done();
  }
});

test('a workspace whose charts have all gone saves as one that never had any', async () => {
  const { engine, done } = connect();
  try {
    const { sources } = await opened(engine, [SOUTH], [newer('south')]);
    await engine.remove(sources[1]!);

    const entries = Object.keys(unzipSync(await saved(engine)));
    expect(entries.sort()).toEqual(
      [MANIFEST_ENTRY, STATE_ENTRY, LOG_ENTRY].sort(),
    );
  } finally {
    done();
  }
});

test('a save writes a chart at the place it is told, and one it is not told where it stood', async () => {
  const { engine, done } = connect();
  try {
    await opened(engine, [NORTH, SOUTH]);
    const moved = { x: 0.25, y: 0.5, width: 300, height: 200 };
    const charts = [
      { id: NORTH.id, place: moved },
      { id: 'gone', place: moved },
    ];
    const place = { source: 'north', cells: [], at: '', charts };
    const back = readContainer(
      'q3.uno',
      await engine.save(place, CARRIES_NOTHING),
    );
    expect(back.charts).toStrictEqual([{ ...NORTH, place: moved }, SOUTH]);
  } finally {
    done();
  }
});

test('a save told a place a read would refuse keeps the chart where it stood', async () => {
  const { engine, done } = connect();
  try {
    await opened(engine, [NORTH, SOUTH]);
    const wild = { x: 2, y: 0, width: 300, height: 200 };
    const nothing = { x: 0, y: 0, width: 0, height: 200 };
    const charts = [
      { id: NORTH.id, place: wild },
      { id: SOUTH.id, place: nothing },
    ];
    const place = { source: 'north', cells: [], at: '', charts };
    const back = readContainer(
      'q3.uno',
      await engine.save(place, CARRIES_NOTHING),
    );
    expect(back.charts).toStrictEqual([NORTH, SOUTH]);
  } finally {
    done();
  }
});

test('a chart request adds a chart over a source it holds, or replaces the one with its id where it stood', async () => {
  const { engine, done } = connect();
  try {
    await opened(engine, []);
    await engine.chart(NORTH);
    await engine.chart(SOUTH);
    const titled = { ...NORTH, title: 'Rows per region' };
    await engine.chart(titled);
    const west = { ...SOUTH, source: 'west' };
    await expect(engine.chart(west)).rejects.toThrow('no source called west');

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([titled, SOUTH]);
  } finally {
    done();
  }
});

test('an unchart request removes the chart it names, and refuses one there is not', async () => {
  const { engine, done } = connect();
  try {
    await opened(engine, [NORTH, SOUTH]);
    await engine.unchart(NORTH.id);
    await expect(engine.unchart(NORTH.id)).rejects.toMatchObject({
      said: { t: 'no-such-chart', id: NORTH.id },
    });

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([SOUTH]);
  } finally {
    done();
  }
});

test('a chart past the most a workspace keeps is refused, counting the carried ones', async () => {
  const { engine, done } = connect();
  try {
    // The .uno leaves room for one chart more, the last a workspace keeps.
    const carried = [newer('north')];
    const charts = Array.from(
      { length: CHARTS_AT_MOST - carried.length - 1 },
      (_, i) => ({ ...NORTH, id: `c${i + 1}` }),
    );
    await opened(engine, charts, carried);
    await engine.chart({ ...SOUTH, id: 'last' });
    const past = { ...SOUTH, id: 'one-more' };
    const refused = { said: { t: 'charts-at-most', limit: CHARTS_AT_MOST } };
    await expect(engine.chart(past)).rejects.toMatchObject(refused);
    // One that replaces a chart takes no place of its own.
    await engine.chart({ ...NORTH, title: 'Rows per region' });
  } finally {
    done();
  }
});

test('charts this build cannot read are written back whole, and refuse every change', async () => {
  const { engine, done } = connect();
  try {
    const json = { version: CHARTS_VERSION + 1, charts: [NORTH] };
    const entry = new TextEncoder().encode(JSON.stringify(json));
    const extra = new Map([[CHARTS_ENTRY, entry]]);
    const added = await opened(engine, [], [], extra);
    expect(added.charts).toStrictEqual([]);
    expect(added.chartsNote).toStrictEqual({ t: 'charts-newer' });
    const refused = { said: { t: 'charts-newer' } };
    await expect(engine.chart(SOUTH)).rejects.toMatchObject(refused);
    await expect(engine.unchart(NORTH.id)).rejects.toMatchObject(refused);

    expect(unzipSync(await saved(engine))[CHARTS_ENTRY]).toStrictEqual(entry);
  } finally {
    done();
  }
});

test('a new chart cannot take the id of a chart the workspace carries', async () => {
  const { engine, done } = connect();
  try {
    // A repeated id is carried too, and the chart shown with it can change.
    const repeated = { ...SOUTH, id: NORTH.id };
    const carried = newer('north');
    const added = await opened(engine, [NORTH, repeated], [carried]);
    expect(added.carriedIds).toStrictEqual([NORTH.id, carried.id]);
    expect(added.carriedOver).toStrictEqual([repeated.source, carried.source]);
    const titled = { ...NORTH, title: 'Rows per region' };
    await engine.chart(titled);
    const same = { ...SOUTH, id: carried.id };
    const taken = { said: { t: 'chart-id-taken', id: carried.id } };
    await expect(engine.chart(same)).rejects.toMatchObject(taken);

    const back = readContainer('q3.uno', await saved(engine));
    expect(back.charts).toStrictEqual([titled, repeated]);
  } finally {
    done();
  }
});
