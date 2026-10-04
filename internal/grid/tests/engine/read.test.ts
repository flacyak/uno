// Reading through the engine: the fixture by path and by Blob, the Band a
// client holds, RowIndex, Pages, failed opens, and closing mid-open.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import {
  Band,
  Engine,
  Pages,
  RowIndex,
  english,
  indexPass,
  messagePort,
  serve,
} from "../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request } from "../../src/engine/index.ts";
import { openFormat } from "../../src/ingest/index.ts";
import { isNumber } from "../../src/num/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { sources } from "../../src/plugin/index.ts";
import { blobSource } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { LAST_ROW, REGION, REVENUE, ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  FIXTURE,
  SCREEN,
  TINY,
  bytes,
  connect,
  openOne,
  indexed,
  sales,
  sheetRows,
  widened,
  saidIn,
} from "./harness.ts";

/** The rows a Band keeps around the viewport, in engine/client.ts. */
const BAND_ROWS = 2000;

test("the engine reads the fixture the way read does", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    const opened = src.opened;
    expect(saidIn(opened.label)).toBe("UTF-8 · delimiter ','");
    // Same columns as `read`: units is text flagged as numeric.
    expect(opened.columns).toEqual(sales.columns);
    expect(opened.columns[UNITS]).toEqual({ header: "units", kind: "text", flagged: true });

    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });

    const page = 500;
    for (let first = 0; first < ROWS; first += page) {
      const { rows } = await src.rows(first, page);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, page, "raw"));
    }
  } finally {
    done();
  }
});

test("a band holds the rows around the viewport, and only those", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);

    let asked = 0;
    const rows = src.rows.bind(src);
    src.rows = (first, count) => {
      asked++;
      return rows(first, count);
    };

    let landed = (): void => {};
    const band = new Band(src, () => landed());
    expect(band.rows()).toBe(ROWS);
    expect(band.readable(), "indexed to the end, so every row can be read").toBe(ROWS);
    expect(band.ready(LAST_ROW), "nothing has arrived yet").toBe(false);

    const arrived = new Promise<void>((r) => (landed = r));
    band.view(ROWS - SCREEN, SCREEN);
    await arrived;

    expect(band.display(LAST_ROW, REVENUE)).toBe(sales.display(LAST_ROW, REVENUE));
    expect(band.ready(ROWS - BAND_ROWS)).toBe(true);
    expect(band.ready(ROWS - BAND_ROWS - 1), "a band is 2,000 rows, not the file").toBe(false);

    // A view inside the band is served from it. One outside asks for rows.
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
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
    const rows = sales.rows();

    // Every units cell whose text fails to parse as a number, from the Sheet.
    const unparsed: number[] = [];
    for (let row = 0; row < rows; row++) {
      const v = sales.display(row, UNITS).trim();
      if (v !== "" && !isNumber(v)) unparsed.push(row);
    }
    const units = (from: number, dir: 1 | -1) =>
      src.find({ col: UNITS, from, dir, match: { t: "unparsed" } });

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

    // A find for unparsed cells in a text column comes back empty.
    const region = await src.find({ col: REGION, from: 0, dir: 1, match: { t: "unparsed" } });
    expect(region).toEqual({ row: null, searched: 0, complete: true });

    const north = [...Array(rows).keys()].find(
      (r) => r > 0 && sales.display(r, REGION).includes("North"),
    );
    const text = await src.find({
      col: REGION,
      from: 0,
      dir: 1,
      match: { t: "text", text: "North" },
    });
    expect(text.row).toBe(north);

    // After the apply, only the cell set to "n/a" is unparsed.
    const far = 4000;
    engine.mode(true);
    await src.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: 'replace(/,/, "")' });
    await src.edit({ op: Op.Set, row: far, col: UNITS, now: "n/a" });
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
  // Five rows in the first 50 of 1,000 bytes project to 100.
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

test("the index keeps block starts past 4 GB exactly, at two numbers a block", () => {
  const MB = 1 << 20;
  const GB = 1024 * MB;
  const size = 6 * GB;
  const index = new RowIndex(0, size, { blockRows: 1024, blockBytes: MB });
  // One row per megabyte, so each begin closes a block, and 5,120 of them
  // reach past 4 GB.
  const blocks = 5 * 1024;
  for (let b = 0; b < blocks; b++) index.begin(b * MB + 1);
  index.scanned = blocks * MB;

  const last = blocks - 1;
  expect(last * MB + 1).toBeGreaterThan(2 ** 32);
  expect(index.bytesOf(last)).toEqual([last * MB + 1, size]);
  expect(index.blockOf(last)).toBe(last);
  // 5 * 1024 rows in the first 5 GB of 6 project to 6 * 1024.
  expect(index.rows()).toBe(6 * 1024);
  index.complete = true;
  expect(index.rows()).toBe(blocks);
  expect(index.readable()).toBe(blocks);
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

/** counted is the disk provider with opens and closes counted. */
function counted(): {
  provider: Provider;
  opens: () => number;
  closes: () => number;
  /** Resolves when a file is closed. */
  closed: Promise<void>;
} {
  const disk = diskProvider();
  let opens = 0;
  let closes = 0;
  let close: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    provider: {
      ...disk,
      files: {
        label: disk.files.label,
        handles: (ref) => disk.files.handles(ref),
        async open(ref) {
          opens++;
          const source = await disk.files.open(ref);
          return {
            size: source.size,
            version: source.version,
            read: (offset, length) => source.read(offset, length),
            async close() {
              await source.close();
              closes++;
              close();
            },
          };
        },
      },
    },
    opens: () => opens,
    closes: () => closes,
    closed,
  };
}

// The engine is closed while an open is in progress. The file the open lands
// with is still closed.
test("an engine closed while a file is opening closes the file", async () => {
  const disk = counted();
  const { engine, done } = connect(TINY, [disk.provider]);
  const opening = engine.open({ name: "sales-q3.csv", path: FIXTURE });
  done();
  await expect(opening).rejects.toThrow("the engine was closed");

  await disk.closed;
  expect(disk.opens()).toBe(1);
  expect(disk.closes()).toBe(1);
});

// An open still queued at the close is rejected before it starts.
test("an engine closed with opens waiting their turn opens none of them", async () => {
  const disk = counted();
  const { engine, done } = connect(TINY, [disk.provider]);
  const first = engine.open({ name: "sales-q3.csv", path: FIXTURE });
  const second = engine.open({ name: "again.csv", path: FIXTURE });
  done();
  await expect(first).rejects.toThrow("the engine was closed");
  await expect(second).rejects.toThrow("the engine was closed");

  await disk.closed;
  expect(disk.opens()).toBe(1);
  expect(disk.closes()).toBe(1);
});

// The engine's port closes with an open in flight. The open rejects, later
// opens reject, and onError hears it once.
test("an engine whose port goes with a request out refuses it, and says so once", async () => {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    sources([diskProvider()]),
  );
  const engine = new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
  const said: string[] = [];
  engine.onError = (heard) => said.push(english(heard));

  const opening = engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
  port1.close();
  await expect(opening).rejects.toThrow("the connection to the engine closed");
  await expect(engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) })).rejects.toThrow(
    "the connection to the engine closed",
  );
  expect(said).toEqual(["the connection to the engine closed"]);
});
