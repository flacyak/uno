// Files with no header row, opened in the engine.
//
// The engine is the real one over a real channel, reading three files on a
// disk as one source said to have no header. What it shows is held to the
// whole fixture read the ordinary way: the same rows, in the same order,
// under columns the engine named itself.

import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Engine, SourceHandle } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { COLS, REGION, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { PART_ROWS } from "../testdata/sales-q3-parts.ts";
import {
  FIXTURE,
  TINY,
  connect,
  indexed,
  openOne,
  sales,
  widened,
  saidIn,
} from "../engine/harness.ts";
import { COLUMNS, NAMES, SOURCE, asOne, marked, onDisk, providers, rowsOnly } from "./parts.ts";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** The first row of each part: the rows a reader that took a header would lose. */
const FIRST_ROWS = [0, PART_ROWS, 2 * PART_ROWS];

const NO_HEADER = "UTF-8 · delimiter ',' · no header row";

let dir: string;
let paths: string[];
beforeAll(async () => {
  ({ dir, paths } = await onDisk());
});
const dirs: string[] = [];
afterAll(() => Promise.all([dir, ...dirs].map((d) => rm(d, { recursive: true, force: true }))));

let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  done = undefined;
});

/** An engine that reads disks, and several files as one. */
function engine(): Engine {
  const made = connect(TINY, providers());
  done = made.done;
  return made.engine;
}

/** Every row of a source, as it shows them. */
async function every(src: SourceHandle): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += PAGE) {
    rows.push(...(await src.rows(first, PAGE)).rows);
  }
  return rows;
}

/** A row of the whole fixture, as the ordinary read of it holds it. */
function expected(row: number): string[] {
  return Array.from({ length: COLS }, (_, col) => sales.raw(row, col));
}

describe("three headerless files opened as one", () => {
  test("show numbered columns, and say there is no header row", async () => {
    const src = await openOne(engine(), asOne(paths));
    expect(src.opened.name).toBe(SOURCE);
    expect(src.opened.columns.map((c) => c.header)).toEqual(COLUMNS);
    expect(saidIn(src.opened.label)).toBe(NO_HEADER);
  });

  test("show every line of every file as a row, in order", async () => {
    const src = await openOne(engine(), asOne(paths));
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });

    // A row short of cells is shown as wide as the columns, as the grid draws it.
    const rows = widened(await every(src));
    expect(rows).toHaveLength(ROWS);
    for (let row = 0; row < ROWS; row++) {
      expect(rows[row], `row ${row}`).toEqual(expected(row));
    }
  });

  test("keep the first row of each file, which a header would have taken", async () => {
    const src = await openOne(engine(), asOne(paths));
    await indexed(src);
    for (const row of FIRST_ROWS) {
      expect(widened((await src.rows(row, 1)).rows)[0], `row ${row}`).toEqual(expected(row));
    }
  });

  test("give each column the kind the same values have under a header", async () => {
    const e = engine();
    const headerless = await openOne(e, asOne(paths));
    const kinds = headerless.opened.columns.map((c) => c.kind);
    done?.();

    const whole = await openOne(engine(), { name: "sales-q3.csv", path: FIXTURE });
    expect(kinds).toEqual(whole.opened.columns.map((c) => c.kind));
  });

  test("take an edit to the very first row, and to the first row of a later file", async () => {
    const e = engine();
    const src = await openOne(e, asOne(paths));
    await indexed(src);
    e.mode(true);

    for (const row of [FIRST_ROWS[0]!, FIRST_ROWS[2]!]) {
      await src.edit({ op: Op.Set, row, col: UNITS, now: "7" });
      expect((await src.rows(row, 1)).rows[0]![UNITS]).toBe("7");
      // The rows either side are what they were.
      expect((await src.rows(row + 1, 1)).rows[0]![UNITS]).toBe(sales.raw(row + 1, UNITS));
    }
  });

  test("find text in the first row, which is a row and can match", async () => {
    const src = await openOne(engine(), asOne(paths));
    await indexed(src);
    const region = sales.raw(0, REGION);
    // A search never matches the row it starts beside, so it looks up from row 1.
    const found = await src.find({
      col: REGION,
      from: 1,
      dir: -1,
      match: { t: "text", text: region },
    });
    expect(found.row).toBe(0);
  });
});

describe("a peek at headerless files", () => {
  test("shows numbered columns over the first lines, the very first included", async () => {
    const peeked = await engine().peek(asOne(paths));
    expect(peeked.header).toEqual(COLUMNS);
    expect(saidIn(peeked.label)).toBe(NO_HEADER);
    expect(peeked.rows[0]).toEqual(expected(0));
    expect(peeked.rows[1]).toEqual(expected(1));
  });
});

describe("headerless files that begin with a byte order mark", () => {
  test("open with the mark in no cell", async () => {
    const made = await onDisk(rowsOnly.map(marked));
    dirs.push(made.dir);
    const src = await openOne(engine(), asOne(made.paths));
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
    for (const row of FIRST_ROWS) {
      expect(widened((await src.rows(row, 1)).rows)[0], `row ${row}`).toEqual(expected(row));
    }
  });
});

describe("what a header mode does not change", () => {
  test("the same files said to have a header are refused: their first rows are not one header", async () => {
    await expect(openOne(engine(), asOne(paths, "first"))).rejects.toThrow(
      `${NAMES[1]} (part 2 of 3)`,
    );
  });

  test("one file opened on its own still takes its first line for names", async () => {
    const src = await openOne(engine(), { name: "sales-q3.csv", path: FIXTURE });
    await indexed(src);
    expect(src.opened.columns.map((c) => c.header)).toEqual(sales.columns.map((c) => c.header));
    expect(saidIn(src.opened.label)).toBe("UTF-8 · delimiter ','");
    expect(src.progress.rows).toBe(ROWS);
  });
});
