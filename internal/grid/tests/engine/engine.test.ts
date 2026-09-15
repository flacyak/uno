// The engine end to end: a real MessageChannel between a client and `serve`,
// the fixture read by path and by Blob, and every row compared with what a Sheet
// builds from the same bytes and the same log.

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { newManifest, readDocument, writeDocument } from "../../src/document/index.ts";
import {
  Band,
  Engine,
  Pages,
  RowIndex,
  indexPass,
  messagePort,
  serve,
} from "../../src/engine/index.ts";
import type { MessagePortLike, Offer, Reply, Request, Tuning } from "../../src/engine/index.ts";
import { openFormat, read } from "../../src/ingest/index.ts";
import { isNumber } from "../../src/num/index.ts";
import { snap } from "../../src/pattern/index.ts";
import { parse as parseProgram, text as programText } from "../../src/program/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import type { Sheet } from "../../src/sheet/index.ts";
import { blobSource } from "../../src/store/index.ts";
import { nodeSource } from "../../src/store/node.ts";

const FIXTURE = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
const bytes = new Uint8Array(readFileSync(FIXTURE));
const sales = read("sales-q3.csv", bytes);

// date,region,rep,channel,units,revenue
const REGION = 1;
const CHANNEL = 3;
const UNITS = 4;

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

function indexed(engine: Engine): Promise<void> {
  return new Promise((resolve) => {
    if (engine.progress?.complete === true) return resolve();
    engine.onProgress = (p) => {
      if (p.complete) resolve();
    };
  });
}

/** What a Sheet shows and stores for a run of rows, as wide as its header. */
function sheetRows(s: Sheet, first: number, count: number, what: "raw" | "display"): string[][] {
  const out: string[][] = [];
  for (let row = first; row < Math.min(first + count, s.rows()); row++) {
    out.push(s.columns.map((_, col) => s[what](row, col)));
  }
  return out;
}

/** Rows as wide as the header, the way a Sheet reads a short one: padded with "". */
function widened(rows: string[][]): string[][] {
  return rows.map((r) => sales.columns.map((_, col) => r[col] ?? ""));
}

test("the engine reads the fixture the way read does", async () => {
  const { engine, done } = connect(TINY);
  try {
    const opened = await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    expect(opened.label).toBe("UTF-8 · delimiter ','");
    // The same sample, so the same badges: units is numeric data in a costume.
    expect(opened.columns).toEqual(sales.columns);
    expect(opened.columns[UNITS]).toEqual({ header: "units", kind: "text", flagged: true });

    await indexed(engine);
    expect(engine.progress).toMatchObject({ rows: 4812, readable: 4812, complete: true });

    for (let first = 0; first < 4812; first += 500) {
      const { rows } = await engine.rows(first, 500);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, 500, "raw"));
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
    expect(band.readable(), "indexed to the end, so every row can be read").toBe(4812);
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

test("an edit shows in the next rows, and undo takes it back", async () => {
  const { engine, done } = connect(TINY);
  try {
    await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);
    engine.mode(true);

    const set = await engine.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    expect(set.edit).toEqual({ seq: 1, op: "set", row: 0, col: UNITS, was: "1,204", now: "1204" });
    expect((await engine.rows(0, 1)).rows[0]![UNITS]).toBe("1204");

    // One line for the whole column, and the last rows of the file show it at once.
    const apply = await engine.edit({
      op: Op.Apply,
      row: NO_ROW,
      col: UNITS,
      now: 'replace(/,/, "")',
    });
    expect(apply.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    const tail = await engine.rows(4790, 22);
    expect(tail.generation).toBe(2);
    expect(tail.rows.some((r) => (r[UNITS] ?? "").includes(","))).toBe(false);

    const undone = await engine.undo();
    expect(undone.edit.op).toBe("apply");
    expect(undone.generation).toBe(3);
    expect(undone.columns[UNITS]).toMatchObject({ kind: "text", flagged: true });
    expect((await engine.rows(5, 1)).rows[0]![UNITS]).toBe("1,101");
    expect((await engine.rows(0, 1)).rows[0]![UNITS], "undo took back one edit").toBe("1204");
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

    for (const from of [0, 7, 2400, 4811]) {
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
    engine.mode(true);
    await engine.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: 'replace(/,/, "")' });
    await engine.edit({ op: Op.Set, row: 4000, col: UNITS, now: "n/a" });
    expect((await units(0, 1)).row).toBe(4000);
    expect((await units(4000, 1)).row).toBe(null);
    expect((await units(4811, -1)).row).toBe(4000);
  } finally {
    done();
  }
});

test("the engine refuses what a Sheet refuses, in the same words", async () => {
  const { engine, done } = connect();
  try {
    await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);

    await expect(engine.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" })).rejects.toThrow(
      "the file is in view",
    );

    engine.mode(true);
    await engine.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: "revenue / units" });
    await expect(engine.edit({ op: Op.Set, row: 0, col: CHANNEL, now: "x" })).rejects.toThrow(
      "edit 2: channel is computed by a formula, so its cells cannot be typed into",
    );
    await expect(engine.edit({ op: Op.Set, row: 9999, col: UNITS, now: "x" })).rejects.toThrow(
      "edit 2: row 9999 is outside the 4812 rows of this sheet",
    );
    await expect(
      engine.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: "explode()" }),
    ).rejects.toThrow("edit 2:");
  } finally {
    done();
  }
});

// The rule that makes a lazy log safe: whatever order the edits came in, a row
// finished through the engine is the row a Sheet holds after the same edits.
test("rows through the engine match a Sheet replaying the same log", async () => {
  const { engine, done } = connect(TINY);
  try {
    await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);
    engine.mode(true);

    const requests = [
      { op: Op.Set, row: 0, col: UNITS, now: "1204" },
      { op: Op.Set, row: 7, col: UNITS, now: "12,000" },
      { op: Op.Apply, row: NO_ROW, col: UNITS, now: 'replace(/,/, "")' },
      { op: Op.Set, row: 9, col: UNITS, now: "9,999" },
      { op: Op.Note, row: 3, col: REGION, now: "x^2" },
      { op: Op.Bind, row: NO_ROW, col: CHANNEL, now: "revenue / units" },
    ];
    const log = [];
    for (const req of requests) log.push((await engine.edit(req)).edit);

    const sheet = read("sales-q3.csv", bytes);
    sheet.replay(log);

    for (let first = 0; first < 4812; first += 800) {
      const r = await engine.rows(first, 800);
      const raws = r.rows.map((shown, i) => r.raws[i] ?? shown);
      expect(widened(r.rows), `shown from ${first}`).toEqual(
        sheetRows(sheet, first, 800, "display"),
      );
      expect(widened(raws), `stored from ${first}`).toEqual(sheetRows(sheet, first, 800, "raw"));
    }
    expect(sheet.display(9, UNITS), "a set after the apply is not rewritten").toBe("9,999");
    expect(sheet.display(3, REGION)).toBe("x²");
  } finally {
    done();
  }
});

test("three fixes stream an offer that ends as the one snap makes", async () => {
  const { engine, done } = connect(TINY);
  try {
    await engine.open({ name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(engine);
    engine.mode(true);

    const final = new Promise<Offer>((resolve) => {
      engine.onOffer = (o) => {
        if (o?.complete === true) resolve(o);
      };
    });
    for (const [row, now] of [
      [0, "1204"],
      [2, "1455"],
      [4, "2038"],
    ] as const) {
      await engine.edit({ op: Op.Set, row, col: UNITS, now });
    }
    const offer = await final;

    const sheet = read("sales-q3.csv", bytes);
    sheet.set(0, UNITS, "1204");
    sheet.set(2, UNITS, "1455");
    sheet.set(4, UNITS, "2038");
    const p = snap(sheet).propose()!;

    expect(offer).toMatchObject({
      col: UNITS,
      header: "units",
      program: programText(p.prog),
      description: "remove commas",
      affects: 3149,
      ambiguous: false,
      scanned: 4812,
      rows: 4812,
      complete: true,
    });
    expect(offer.sample).toEqual(p.sample);

    // Apply is one edit, and the column has nothing left to ask about.
    const cleared = new Promise<Offer | null>((resolve) => (engine.onOffer = resolve));
    await engine.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: offer.program });
    expect(await cleared).toBeNull();
  } finally {
    done();
  }
});

test("a .uno opens with its log applied, and saves back", async () => {
  const saved = read("sales-q3.csv", bytes);
  saved.set(0, UNITS, "1204");
  saved.apply(UNITS, parseProgram('replace(/,/, "")'));
  const uno = writeDocument({
    manifest: { ...newManifest("sales-q3.csv"), sheet: { rows: 4812, cols: 6, entry: "" } },
    raw: bytes,
    state: { active: { row: 0, col: 0 } },
    edits: saved.edits(),
    extra: new Map(),
  });

  const { engine, done } = connect();
  try {
    const opened = await engine.open({ name: "q3.uno", blob: new Blob([new Uint8Array(uno)]) });
    expect(opened.name).toBe("sales-q3.csv");
    expect(opened.edits).toHaveLength(2);
    expect(opened.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    expect((await engine.rows(5, 1)).rows[0]![UNITS]).toBe("1101");

    engine.mode(true);
    await engine.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const back = readDocument("q3.uno", await engine.save({ row: 1, col: UNITS }, 1 << 20));

    expect(back.edits).toHaveLength(3);
    expect(back.raw).toEqual(bytes);
    expect(back.state.active).toEqual({ row: 1, col: UNITS });
    expect(back.sheet!.raw(1, UNITS)).toBe("986");
    expect(back.sheet!.raw(5, UNITS)).toBe("1101");
  } finally {
    done();
  }
});

test("a save refuses a source over its limit, by name", async () => {
  const { engine, done } = connect();
  try {
    await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    await expect(engine.save({ row: 0, col: 0 }, 1024)).rejects.toThrow(
      /^sales-q3\.csv is .* until it can point at the file instead$/,
    );

    const back = readDocument("sales-q3.uno", await engine.save({ row: 0, col: 0 }, 1 << 20));
    expect(back.raw).toEqual(bytes);
    expect(back.manifest.sheet.rows).toBe(4812);
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
    expect(widened(await pages.rows(first, 100))).toEqual(sheetRows(sales, first, 100, "raw"));
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
