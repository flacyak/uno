// `find` over the fixture: a case-sensitive substring test on what a cell
// shows with the log applied. It skips the row it starts from, stops at the
// end of the file in its direction, and a newer find cancels an older one.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Engine, Found, SourceHandle } from "../../src/engine/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import { CHANNEL, COLS, LAST_ROW, REGION, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, connect, indexed, openOne, sales } from "./harness.ts";

// Column index of rep in date,region,rep,channel,units,revenue.
const REP = 2;

/** A start row before the first, so row 0 is searched. */
const BEFORE = -1;

let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  done = undefined;
});

async function open(): Promise<{ engine: Engine; src: SourceHandle }> {
  const c = connect(TUNING);
  done = c.done;
  const src = await openOne(c.engine, { name: "sales-q3.csv", path: FIXTURE });
  await indexed(src);
  return { engine: c.engine, src };
}

function text(
  src: SourceHandle,
  col: number,
  from: number,
  dir: 1 | -1,
  t: string,
): Promise<Found> {
  return src.find({ col, from, dir, match: { t: "text", text: t } });
}

/** The first row past `from` in `dir` whose cell shows `t`, per the Sheet. */
function expected(col: number, from: number, dir: 1 | -1, t: string): number | null {
  for (let row = from + dir; row >= 0 && row <= LAST_ROW; row += dir) {
    if (sales.display(row, col).includes(t)) return row;
  }
  return null;
}

test("a find lands on the next cell down or up that shows the text, and skips its own row", async () => {
  const { src } = await open();
  const down = await text(src, REGION, 0, 1, "North");
  expect(down).toEqual({
    row: expected(REGION, 0, 1, "North"),
    searched: down.searched,
    complete: true,
  });
  expect(down.row).toBe(2);

  // Row 2 is North. A find from row 2 skips it.
  const next = await text(src, REGION, 2, 1, "North");
  expect(next.row).toBe(expected(REGION, 2, 1, "North"));
  expect(next.row).toBeGreaterThan(2);

  const up = await text(src, REGION, 5, -1, "North");
  expect(up.row).toBe(expected(REGION, 5, -1, "North"));
  expect(up.row).toBe(2);
});

test("a find matches a substring, with the case as typed and no regex", async () => {
  const { src } = await open();
  expect((await text(src, REGION, BEFORE, 1, "ort")).row).toBe(expected(REGION, BEFORE, 1, "ort"));
  expect((await text(src, REGION, BEFORE, 1, "north")).row).toBeNull();
  expect((await text(src, REP, BEFORE, 1, "Ada Okafor")).row).toBe(0);
  // Regex metacharacters are matched literally.
  for (const special of [".", ".*", "(", "[", "\\", "N.rth", "^North$"]) {
    expect((await text(src, REGION, BEFORE, 1, special)).row).toBe(
      expected(REGION, BEFORE, 1, special),
    );
  }
  expect((await text(src, REP, BEFORE, 1, " ")).row).toBe(0);
});

test("a find reads the cell as the file wrote it, grouping and all", async () => {
  const { src } = await open();
  expect((await text(src, UNITS, BEFORE, 1, "1,204")).row).toBe(0);
  expect((await text(src, UNITS, BEFORE, 1, "1204")).row).toBe(expected(UNITS, BEFORE, 1, "1204"));
});

test("a find stops at the end of the file in its direction", async () => {
  const { src } = await open();
  expect(await text(src, REGION, LAST_ROW, 1, "North")).toEqual({
    row: null,
    searched: 0,
    complete: true,
  });
  expect(await text(src, REGION, 0, -1, "North")).toEqual({
    row: null,
    searched: 0,
    complete: true,
  });
  const none = await text(src, REGION, BEFORE, 1, "nowhere");
  expect(none).toEqual({ row: null, searched: LAST_ROW + 1, complete: true });
  const noneUp = await text(src, REGION, LAST_ROW + 1, -1, "nowhere");
  expect(noneUp).toEqual({ row: null, searched: LAST_ROW + 1, complete: true });
});

test("a find for nothing, or in no column, finds nothing", async () => {
  const { src } = await open();
  expect(await text(src, REGION, BEFORE, 1, "")).toEqual({
    row: null,
    searched: 0,
    complete: true,
  });
  expect((await text(src, COLS, BEFORE, 1, "North")).row).toBeNull();
  expect((await text(src, REGION, BEFORE, 1, "North".repeat(100))).row).toBeNull();
});

test("a find reads what the log shows: a written cell, and a bound column's values", async () => {
  const { engine, src } = await open();
  engine.mode(true);
  await src.edit({ op: Op.Set, row: 3, col: REGION, now: "Nowhere" });
  expect((await text(src, REGION, BEFORE, 1, "Nowhere")).row).toBe(3);

  await src.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: "revenue / units" });
  // The channel column now shows 40 in every row, and "direct" nowhere.
  expect((await text(src, CHANNEL, BEFORE, 1, "40")).row).toBe(0);
  expect((await text(src, CHANNEL, BEFORE, 1, "direct")).row).toBeNull();
});

test("a newer find stops an older one", async () => {
  const { src } = await open();
  const older = text(src, REGION, BEFORE, 1, "nowhere");
  const newer = text(src, REGION, BEFORE, 1, "North");
  expect((await newer).row).toBe(2);
  const dropped = await older;
  expect(dropped.row).toBeNull();
  expect(dropped.complete).toBe(false);
});
