// Files with no header row, saved in a workspace and opened again.
//
// A .uno writes down that a source has no header row. An open that forgot it
// would take the first line for names, and every edit in the log would land
// one row below the cell it was made to.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, test } from "vite-plus/test";

import { PARTS_VERSION, readContainer } from "../../src/document/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { PART_ROWS } from "../testdata/sales-q3-parts.ts";
import { TINY, connect, indexed, openOne, sales } from "../engine/harness.ts";
import { COLUMNS, NAMES, SOURCE, asOne, onDisk, providers, rowsOnly } from "./parts.ts";

const UNO = "rows.uno";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** More than any source here would need a save to carry. */
const ROOMY = 1 << 20;

/** The first row of the first file and of the last, and a row in the middle. */
const EDITS = [
  { row: 0, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: 2 * PART_ROWS, now: "4" },
];

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** Every row of a source, as it shows them. */
async function every(src: SourceHandle): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += PAGE) {
    rows.push(...(await src.rows(first, PAGE)).rows);
  }
  return rows;
}

test("headerless files save as having no header row, and reopen with every edit on its cell", async () => {
  const { dir, paths } = await onDisk();
  dirs.push(dir);
  const file = join(dir, UNO);

  // Opened, edited and saved.
  const first = connect(TINY, providers());
  let rows: string[][];
  try {
    const src = await openOne(first.engine, asOne(paths));
    await indexed(src);
    first.engine.mode(true);
    for (const e of EDITS) await src.edit({ op: Op.Set, row: e.row, col: UNITS, now: e.now });
    rows = await every(src);
    await writeFile(file, await first.engine.save({ source: src.id, cells: [], at: file }, ROOMY));
  } finally {
    first.done();
  }

  // What was written: no header row, and so nothing skipped in any part.
  const doc = readContainer(UNO, new Uint8Array(await readFile(file)), file);
  expect(doc.manifest.format).toBe(PARTS_VERSION);
  expect(doc.sources[0]).toMatchObject({ id: SOURCE, header: "none", rows: ROWS });
  expect(doc.sources[0]!.parts!.map((part) => [part.name, part.bytes, part.skip])).toEqual(
    NAMES.map((name, i) => [name, rowsOnly[i]!.length, 0]),
  );

  // Opened again from the save alone.
  const second = connect(TINY, providers());
  try {
    const src = await openOne(second.engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.columns.map((c) => c.header)).toEqual(COLUMNS);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    expect(await every(src)).toEqual(rows);

    for (const e of EDITS) {
      expect((await src.rows(e.row, 1)).rows[0]![UNITS], `row ${e.row}`).toBe(e.now);
      // The row below is untouched: an edit one row out would show here.
      expect((await src.rows(e.row + 1, 1)).rows[0]![UNITS]).toBe(sales.raw(e.row + 1, UNITS));
    }
  } finally {
    second.done();
  }
});
