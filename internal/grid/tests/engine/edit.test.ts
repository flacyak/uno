// Edits through the engine: set, apply, bind, undo, redo, refusals, and the
// offers streamed after fixes. Each is checked against a Sheet given the same
// log.

import { expect, test } from "vite-plus/test";

import type { Offer } from "../../src/engine/index.ts";
import { read } from "../../src/ingest/index.ts";
import { snap } from "../../src/pattern/index.ts";
import { text as programText } from "../../src/program/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import { CHANNEL, COMMAS_LEFT, REGION, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { SCREEN, TINY, bytes, connect, openOne, indexed, sheetRows, widened } from "./harness.ts";

test("an edit shows in the next rows, and undo takes it back", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
    engine.mode(true);

    const set = await src.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    expect(set.edit).toEqual({ seq: 1, op: "set", row: 0, col: UNITS, was: "1,204", now: "1204" });
    expect((await src.rows(0, 1)).rows[0]![UNITS]).toBe("1204");

    // An apply covers the whole column, including the last rows.
    const apply = await src.edit({
      op: Op.Apply,
      row: NO_ROW,
      col: UNITS,
      now: 'replace(/,/, "")',
    });
    expect(apply.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    const tail = await src.rows(ROWS - SCREEN, SCREEN);
    expect(tail.generation).toBe(2);
    expect(tail.rows.some((r) => (r[UNITS] ?? "").includes(","))).toBe(false);

    const undone = await src.undo();
    expect(undone.edit.op).toBe("apply");
    expect(undone.generation).toBe(3);
    expect(undone.columns[UNITS]).toMatchObject({ kind: "text", flagged: true });
    expect((await src.rows(5, 1)).rows[0]![UNITS]).toBe("1,101");
    expect((await src.rows(0, 1)).rows[0]![UNITS], "undo took back one edit").toBe("1204");
  } finally {
    done();
  }
});

test("redo records again what undo took back, until a new edit", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
    await expect(src.redo()).rejects.toThrow("the file is in view");
    engine.mode(true);
    await expect(src.redo()).rejects.toThrow("there is nothing to redo");

    await src.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    await src.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: 'replace(/,/, "")' });
    await src.undo();
    await src.undo();
    expect((await src.rows(0, 1)).rows[0]![UNITS]).toBe("1,204");

    // Redo is oldest first.
    const set = await src.redo();
    expect(set.edit).toEqual({ seq: 1, op: "set", row: 0, col: UNITS, was: "1,204", now: "1204" });
    const apply = await src.redo();
    expect(apply.edit).toMatchObject({ seq: 2, op: "apply" });
    expect(apply.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    expect((await src.rows(5, 1)).rows[0]![UNITS]).toBe("1101");

    // A new edit clears the redo stack.
    await src.undo();
    await src.edit({ op: Op.Set, row: 1, col: UNITS, now: "988" });
    await expect(src.redo()).rejects.toThrow("there is nothing to redo");
  } finally {
    done();
  }
});

test("the engine refuses what a Sheet refuses, in the same words", async () => {
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);

    await expect(src.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" })).rejects.toThrow(
      "the file is in view",
    );

    engine.mode(true);
    await src.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: "revenue / units" });
    await expect(src.edit({ op: Op.Set, row: 0, col: CHANNEL, now: "x" })).rejects.toThrow(
      "edit 2: channel is computed by a formula, so its cells cannot be typed into",
    );
    const outside = 9999;
    await expect(src.edit({ op: Op.Set, row: outside, col: UNITS, now: "x" })).rejects.toThrow(
      `edit 2: row ${outside} is outside the ${ROWS} rows of this sheet`,
    );
    await expect(
      src.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: "explode()" }),
    ).rejects.toThrow("edit 2:");
  } finally {
    done();
  }
});

// A duplicate header is suffixed _2, and a formula reads each by its name.
test("a column named twice in the file can be read by its own name", async () => {
  const header = "sku,product_cost,price,product_cost,margin";
  const csv = `${header}\nA,1,5,2,\nB,3,9,4,\n`;
  const PRICE = 2;
  const MARGIN = 4;
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: "dup.csv", blob: new Blob([csv]) });
    await indexed(src);
    engine.mode(true);

    const bound = await src.edit({
      op: Op.Bind,
      row: NO_ROW,
      col: MARGIN,
      now: "price - product_cost - product_cost_2",
    });
    expect(bound.columns.map((c) => c.header)).toEqual([
      "sku",
      "product_cost",
      "price",
      "product_cost_2",
      "margin",
    ]);
    const rows = (await src.rows(0, 2)).rows;
    expect(rows.map((r) => r[MARGIN])).toEqual(["2", "2"]);
    expect(rows.map((r) => r[PRICE])).toEqual(["5", "9"]);
  } finally {
    done();
  }
});

test("rows through the engine match a Sheet replaying the same log", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
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
    for (const req of requests) log.push((await src.edit(req)).edit);

    const sheet = read("sales-q3.csv", bytes);
    sheet.replay(log);

    const page = 800;
    for (let first = 0; first < ROWS; first += page) {
      const r = await src.rows(first, page);
      const raws = r.rows.map((shown, i) => r.raws[i] ?? shown);
      expect(widened(r.rows), `shown from ${first}`).toEqual(
        sheetRows(sheet, first, page, "display"),
      );
      expect(widened(raws), `stored from ${first}`).toEqual(sheetRows(sheet, first, page, "raw"));
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
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
    engine.mode(true);

    const final = new Promise<Offer>((resolve) => {
      src.onOffer = (o) => {
        if (o?.complete === true) resolve(o);
      };
    });
    for (const [row, now] of [
      [0, "1204"],
      [2, "1455"],
      [4, "2038"],
    ] as const) {
      await src.edit({ op: Op.Set, row, col: UNITS, now });
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
      description: {
        t: "program",
        steps: [{ t: "remove", what: { t: "chars", names: ["commas"], where: "anywhere" } }],
      },
      affects: COMMAS_LEFT,
      ambiguous: false,
      scanned: ROWS,
      rows: ROWS,
      complete: true,
    });
    expect(offer.sample).toEqual(p.sample);

    // After the apply the offer is cleared.
    const cleared = new Promise<Offer | null>((resolve) => (src.onOffer = resolve));
    await src.edit({ op: Op.Apply, row: NO_ROW, col: UNITS, now: offer.program });
    expect(await cleared).toBeNull();
  } finally {
    done();
  }
});

test("an offer counts and applies around the fixes it was learned from", async () => {
  const { engine, done } = connect(TINY);
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await indexed(src);
    engine.mode(true);

    const final = new Promise<Offer>((resolve) => {
      src.onOffer = (o) => {
        if (o?.complete === true) resolve(o);
      };
    });
    const fixes = [
      [0, "West-q3"],
      [1, "East-q3"],
      [2, "North-q3"],
    ] as const;
    for (const [row, now] of fixes) await src.edit({ op: Op.Set, row, col: REGION, now });
    const offer = await final;

    const sheet = read("sales-q3.csv", bytes);
    for (const [row, now] of fixes) sheet.set(row, REGION, now);
    const p = snap(sheet).propose()!;

    // The three rows already fixed are excluded from `affects`.
    expect(p.affects).toBe(ROWS - fixes.length);
    expect(offer).toMatchObject({
      col: REGION,
      program: programText(p.prog),
      affects: ROWS - fixes.length,
    });
    expect(offer.sample).toEqual(p.sample);

    await src.edit({ op: Op.Apply, row: NO_ROW, col: REGION, now: offer.program });
    const { rows } = await src.rows(0, 4);
    expect(rows.map((r) => r[REGION])).toEqual(["West-q3", "East-q3", "North-q3", "South-q3"]);
  } finally {
    done();
  }
});
