// The engine end to end: a real MessageChannel between a client and `serve`,
// the fixture read by path and by Blob, and every row compared with what `read`
// builds from the same bytes.

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import {
  Band,
  Engine,
  Pages,
  RowIndex,
  indexPass,
  messagePort,
  serve,
} from "../../src/engine/index.ts";
import type { MessagePortLike, Reply, Request, Tuning } from "../../src/engine/index.ts";
import { openFormat, read } from "../../src/ingest/index.ts";
import { blobSource } from "../../src/store/index.ts";
import { nodeSource } from "../../src/store/node.ts";

const FIXTURE = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
const bytes = new Uint8Array(readFileSync(FIXTURE));
const sales = read("sales-q3.csv", bytes);

/** Small enough that the 240 KB fixture spans hundreds of blocks and the cache has to evict. */
const TINY: Tuning = { chunkBytes: 4096, blockRows: 7, blockBytes: 512, cacheBytes: 8192 };

function connect(tuning?: Tuning): { engine: Engine; done: () => void } {
  const { port1, port2 } = new MessageChannel();
  serve(
    messagePort<Request, Reply>(port1 as unknown as MessagePortLike),
    (ref) => ("path" in ref ? nodeSource(ref.path) : Promise.resolve(blobSource(ref.blob))),
    tuning,
  );
  const engine = new Engine(messagePort<Reply, Request>(port2 as unknown as MessagePortLike));
  return {
    engine,
    done: () => {
      engine.close();
      port1.close();
    },
  };
}

/** Rows as wide as the header, the way `Sheet.raw` reads a short one: padded with "". */
function widened(rows: string[][]): string[][] {
  return rows.map((r) => sales.columns.map((_, col) => r[col] ?? ""));
}

function indexed(engine: Engine): Promise<void> {
  return new Promise((resolve) => {
    if (engine.progress?.complete === true) return resolve();
    engine.onProgress = (p) => {
      if (p.complete) resolve();
    };
  });
}

function sheetRows(first: number, count: number): string[][] {
  const out: string[][] = [];
  for (let row = first; row < Math.min(first + count, sales.rows()); row++) {
    out.push(sales.columns.map((_, col) => sales.raw(row, col)));
  }
  return out;
}

test("the engine reads the fixture the way read does", async () => {
  const { engine, done } = connect(TINY);
  try {
    const opened = await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    expect(opened.label).toBe("UTF-8 · delimiter ','");
    // The same sample, so the same badges: units is numeric data in a costume.
    expect(opened.columns).toEqual(sales.columns);
    expect(opened.columns[4]).toEqual({ header: "units", kind: "text", flagged: true });

    await indexed(engine);
    expect(engine.progress).toMatchObject({ rows: 4812, readable: 4812, complete: true });

    for (let first = 0; first < 4812; first += 500) {
      const { rows } = await engine.rows(first, 500);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(first, 500));
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
    expect(band.rows()).toBe(4812);
    expect(band.ready(4811), "nothing has arrived yet").toBe(false);

    const arrived = new Promise<void>((r) => (landed = r));
    band.view(4790, 22);
    await arrived;

    expect(band.display(4811, 5)).toBe(sales.display(4811, 5));
    expect(band.ready(4812 - 2000)).toBe(true);
    expect(band.ready(4812 - 2001), "a band is 2,000 rows, not the file").toBe(false);

    // Somewhere the band already covers, a screen either side, asks for nothing.
    band.view(3000, 22);
    expect(asked).toBe(1);
    band.view(100, 22);
    expect(asked).toBe(2);
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
  for (let first = 0; first < 4812; first += 100) {
    expect(widened(await pages.rows(first, 100))).toEqual(sheetRows(first, 100));
    expect(pages.held).toBeLessThanOrEqual(TINY.cacheBytes);
  }
});

test("a failed open names the file", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "uno-engine-")), "nope.csv");
  const cases: Array<[Parameters<Engine["open"]>[0], string]> = [
    [{ name: "nope.csv", path: missing }, missing],
    [{ name: "empty.csv", blob: new Blob([]) }, "empty.csv: file is empty"],
    [{ name: "data.json", blob: new Blob(["[]"]) }, "data.json: JSON is not supported yet"],
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

test("a whole read refuses a file over its limit, by name", async () => {
  const { engine, done } = connect();
  try {
    const ref = { name: "sales-q3.csv", path: FIXTURE };
    await expect(engine.bytes(ref, 1024)).rejects.toThrow(/^sales-q3\.csv is .* read whole$/);
    expect(await engine.bytes(ref, 1 << 20)).toEqual(bytes);
  } finally {
    done();
  }
});
