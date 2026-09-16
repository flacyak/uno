// The engine reading: the fixture by path and by Blob, the band a client holds,
// the index and page cache behind it, and every row compared with what read builds.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { Band, Pages, RowIndex, indexPass } from "../../src/engine/index.ts";
import type { Engine } from "../../src/engine/index.ts";
import { openFormat } from "../../src/ingest/index.ts";
import { isNumber } from "../../src/num/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import { blobSource } from "../../src/store/index.ts";
import { LAST_ROW, REGION, REVENUE, ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  FIXTURE,
  SCREEN,
  TINY,
  bytes,
  connect,
  indexed,
  sales,
  sheetRows,
  widened,
} from "./harness.ts";

/** The rows a Band keeps around the viewport, in engine/client.ts. */
const BAND_ROWS = 2000;

test("the engine reads the fixture the way read does", async () => {
  const { engine, done } = connect(TINY);
  try {
    const opened = await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    expect(opened.label).toBe("UTF-8 · delimiter ','");
    // The same sample, so the same badges: units is numeric data in a costume.
    expect(opened.columns).toEqual(sales.columns);
    expect(opened.columns[UNITS]).toEqual({ header: "units", kind: "text", flagged: true });

    await indexed(engine);
    expect(engine.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });

    const page = 500;
    for (let first = 0; first < ROWS; first += page) {
      const { rows } = await engine.rows(first, page);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, page, "raw"));
    }
  } finally {
    done();
  }
});

test("a band holds the rows around the viewport, and only those", async () => {
  const { engine, done } = connect(TINY);
  try {
    const opened = await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);

    let asked = 0;
    const rows = engine.rows.bind(engine);
    engine.rows = (first, count) => {
      asked++;
      return rows(first, count);
    };

    let landed = (): void => {};
    const band = new Band(engine, opened, () => landed());
    expect(band.rows()).toBe(ROWS);
    expect(band.readable(), "indexed to the end, so every row can be read").toBe(ROWS);
    expect(band.ready(LAST_ROW), "nothing has arrived yet").toBe(false);

    const arrived = new Promise<void>((r) => (landed = r));
    band.view(ROWS - SCREEN, SCREEN);
    await arrived;

    expect(band.display(LAST_ROW, REVENUE)).toBe(sales.display(LAST_ROW, REVENUE));
    expect(band.ready(ROWS - BAND_ROWS)).toBe(true);
    expect(band.ready(ROWS - BAND_ROWS - 1), "a band is 2,000 rows, not the file").toBe(false);

    // Somewhere the band already covers, a screen either side, asks for nothing.
    band.view(3000, SCREEN);
    expect(asked).toBe(1);
    band.view(100, SCREEN);
    expect(asked).toBe(2);
  } finally {
    done();
  }
});

test("find reads the column past any band, with the log applied", async () => {
  const { engine, done } = connect(TINY);
  try {
    await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);
    const rows = sales.rows();

    // Every units cell that does not parse as a number, read the slow way.
    const unparsed: number[] = [];
    for (let row = 0; row < rows; row++) {
      const v = sales.display(row, UNITS).trim();
      if (v !== "" && !isNumber(v)) unparsed.push(row);
    }
    const units = (from: number, dir: 1 | -1) =>
      engine.find({ col: UNITS, from, dir, match: { t: "unparsed" } });

    for (const from of [0, 7, 2400, LAST_ROW]) {
      const down = unparsed.find((r) => r > from) ?? null;
      expect(await units(from, 1), `down from ${from}`).toEqual({
        row: down,
        searched: (down ?? rows - 1) - from,
        complete: true,
      });
      const up = unparsed.findLast((r) => r < from) ?? null;
      expect((await units(from, -1)).row, `up from ${from}`).toBe(up);
    }

    // Text that is not numeric data in a costume has nothing in it to fail.
    const region = await engine.find({ col: REGION, from: 0, dir: 1, match: { t: "unparsed" } });
    expect(region).toEqual({ row: null, searched: 0, complete: true });

    const north = [...Array(rows).keys()].find(
      (r) => r > 0 && sales.display(r, REGION).includes("North"),
    );
    const text = await engine.find({
      col: REGION,
      from: 0,
      dir: 1,
      match: { t: "text", text: "North" },
    });
    expect(text.row).toBe(north);

    // With the commas gone nothing fails, until one cell far below is typed over.
    const far = 4000;
    engine.mode(true);
    await engine.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: 'replace(/,/, "")' });
    await engine.edit({ op: Op.Set, row: far, col: UNITS, now: "n/a" });
    expect((await units(0, 1)).row).toBe(far);
    expect((await units(far, 1)).row).toBe(null);
    expect((await units(LAST_ROW, -1)).row).toBe(far);
  } finally {
    done();
  }
});

test("the index serves closed blocks only, and projects the row count", () => {
  const index = new RowIndex(10, 1010, { blockRows: 2, blockBytes: 1 << 20 });
  for (const offset of [10, 20, 30, 40, 50]) index.begin(offset);
  index.scanned = 60;

  // Blocks start at rows 0, 2 and 4. The one at 4 may still grow.
  expect(index.readable()).toBe(4);
  expect(index.blockOf(3)).toBe(1);
  expect(index.rowsOf(1)).toEqual([2, 4]);
  expect(index.bytesOf(1)).toEqual([30, 50]);
  // Five rows in the first 50 of 1,000 bytes.
  expect(index.rows()).toBe(100);

  index.complete = true;
  expect(index.readable()).toBe(5);
  expect(index.rows()).toBe(5);
  expect(index.bytesOf(2)).toEqual([50, 1010]);
});

test("a block closes at its byte budget as well as its row count", () => {
  const index = new RowIndex(0, 100, { blockRows: 100, blockBytes: 25 });
  for (const offset of [0, 10, 20, 30, 40, 60]) index.begin(offset);
  // 30 is 30 bytes past the block at 0, and 60 is 30 past the one at 30.
  expect(index.readable()).toBe(5);
  expect(index.blockOf(2)).toBe(0);
  expect(index.blockOf(3)).toBe(1);
});

test("the page cache stays within its budget however much is read", async () => {
  const source = blobSource(new Blob([bytes]));
  const format = await openFormat("sales-q3.csv", source);
  const index = new RowIndex(format.dataStart, source.size, TINY);
  await indexPass({
    source,
    format,
    index,
    tuning: TINY,
    signal: new AbortController().signal,
    progress() {},
  });

  const pages = new Pages("sales-q3.csv", source, format, index, TINY.cacheBytes);
  const page = 100;
  for (let first = 0; first < ROWS; first += page) {
    expect(widened(await pages.rows(first, page))).toEqual(sheetRows(sales, first, page, "raw"));
    expect(pages.held).toBeLessThanOrEqual(TINY.cacheBytes);
  }
});

test("a failed open names the file", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "uno-engine-")), "nope.csv");
  const cases: Array<[Parameters<Engine["open"]>[0], string]> = [
    [{ name: "nope.csv", path: missing }, missing],
    [{ name: "empty.csv", blob: new Blob([]) }, "empty.csv: file is empty"],
    [{ name: "data.json", blob: new Blob(["[]"]) }, "data.json: JSON is not supported yet"],
    [{ name: "broken.uno", blob: new Blob(["not a zip"]) }, "broken.uno is not a readable .uno"],
  ];

  for (const [ref, want] of cases) {
    const { engine, done } = connect();
    try {
      await expect(engine.open(ref)).rejects.toThrow(want);
    } finally {
      done();
    }
  }
});
