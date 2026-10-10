// A headerless source saved to a .uno records header mode "none", and
// reopening it puts every logged edit on the same row.

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, test } from "vite-plus/test";

import { PARTS_VERSION, readContainer } from "../../src/document/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import { PART_ROWS } from "../testdata/sales-q3-parts.ts";
import { connect, everyRow, indexed, openOne, sales, TINY } from "../engine/harness.ts";
import { COLUMNS, NAMES, SOURCE, asOne, onDisk, providers, rowsOnly } from "./parts.ts";

const UNO = "rows.uno";

/** Byte budget for save, larger than any source here. */
const ROOMY = 1 << 20;

/** Edits on the first row of the first part, a middle row, and the first row of the last part. */
const EDITS = [
  { row: 0, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: 2 * PART_ROWS, now: "4" },
];

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

test("headerless files save as having no header row, and reopen with every edit on its cell", async () => {
  const { dir, paths } = await onDisk();
  dirs.push(dir);
  const file = join(dir, UNO);

  // Open, edit and save.
  const first = connect(TINY, providers());
  let rows: string[][];
  try {
    const src = await openOne(first.engine, asOne(paths));
    await indexed(src);
    first.engine.mode(true);
    for (const e of EDITS) await src.edit({ op: Op.Set, row: e.row, col: UNITS, now: e.now });
    rows = await everyRow(src);
    await writeFile(file, await first.engine.save({ source: src.id, cells: [], at: file }, ROOMY));
  } finally {
    first.done();
  }

  // The saved document records header "none" and skip 0 for every part.
  const doc = readContainer(UNO, new Uint8Array(await readFile(file)), file);
  expect(doc.manifest.format).toBe(PARTS_VERSION);
  expect(doc.sources[0]).toMatchObject({ id: SOURCE, header: "none", rows: ROWS });
  expect(doc.sources[0]!.parts!.map((part) => [part.name, part.bytes, part.skip])).toEqual(
    NAMES.map((name, i) => [name, rowsOnly[i]!.length, 0]),
  );

  // Reopen from the saved file.
  const second = connect(TINY, providers());
  try {
    const src = await openOne(second.engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.columns.map((c) => c.header)).toEqual(COLUMNS);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    expect(await everyRow(src)).toEqual(rows);

    for (const e of EDITS) {
      expect((await src.rows(e.row, 1)).rows[0]![UNITS], `row ${e.row}`).toBe(e.now);
      // The row below is unchanged.
      expect((await src.rows(e.row + 1, 1)).rows[0]![UNITS]).toBe(sales.raw(e.row + 1, UNITS));
    }
  } finally {
    second.done();
  }
});
