// `engine.append`: adding parts to the end of a source of several files read
// as one. The rows extend, the log is unchanged, and every edit stays on its
// cell, in the open source and in a save of it.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import { FILE_COLUMN } from "../../src/engine/index.ts";
import type { Engine, SourceHandle, SourceRef } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import type { SingleRef } from "../../src/store/index.ts";
import { COLS, ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
  partBytes,
} from "../testdata/sales-q3-parts.ts";
import {
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
  sales,
  sheetRows,
  widened,
  FIXTURE,
  TINY,
} from "./harness.ts";

/** What the parts are called as one source. */
const NAME = "sales-q3";

/** What the workspace is saved as. */
const UNO = "q3.uno";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** A save limit larger than any carried source here. */
const ROOMY = 1 << 20;

/** How many parts the source is opened with, the rest being appended. */
const OPENED = PARTS - 1;

/** How many rows the source has before the append. */
const ROWS_BEFORE = PART_ROWS * OPENED;

/** A units cell edited in each opened part, the last one on the last row. */
const EDITS = [
  { row: 1, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: ROWS_BEFORE - 1, now: "4" },
];

/** A cell in the appended part, edited once it is there. */
const LATER = { row: ROWS - 1, now: "12" };

/** Part `i` of the fixture as a ref to its file on disk. */
function part(i: number): SingleRef {
  return { name: PART_NAMES[i]!, path: PART_FIXTURES[i]! };
}

/** The parts the source is opened with, as one ref. */
const FIRST_TWO: SourceRef = {
  name: NAME,
  parts: Array.from({ length: OPENED }, (_, i) => ({ ref: part(i) })),
  header: "first",
};

/** The part that is appended. */
const THIRD = part(OPENED);

/** The whole file's rows with `edits` made to its units. */
function expected(edits: ReadonlyArray<{ row: number; now: string }>, rows = ROWS): string[][] {
  const all = sheetRows(sales, 0, rows, "raw");
  for (const e of edits) all[e.row]![UNITS] = e.now;
  return all;
}

/** FIRST_TWO opened, indexed, put in transform mode, with EDITS made. */
async function edited(engine: Engine): Promise<SourceHandle> {
  const src = await openOne(engine, FIRST_TWO);
  await indexed(src);
  engine.mode(true);
  for (const e of EDITS) await src.edit({ op: Op.Set, row: e.row, col: UNITS, now: e.now });
  return src;
}

/** Edits as [row, now] pairs. */
function made(edits: ReadonlyArray<{ row: number; now: string }>): Array<[number, string]> {
  return edits.map((e) => [e.row, e.now]);
}

test("a source with a _file column names the appended part on the rows it brings", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const before = await openOne(engine, { ...FIRST_TWO, fileColumn: true });
    await indexed(before);

    const src = await engine.append(before, [THIRD]);
    await indexed(src);
    expect(src.opened.columns.at(-1)?.header).toBe(FILE_COLUMN);

    const files = (await everyRow(src)).map((row) => row[COLS]);
    expect(files).toHaveLength(ROWS);
    expect(files).toEqual(files.map((_, row) => PART_NAMES[Math.floor(row / PART_ROWS)]));
  } finally {
    done();
  }
});

test("a part appended extends the rows and leaves every edit on its cell", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const before = await edited(engine);
    expect(before.progress).toMatchObject({ rows: ROWS_BEFORE, complete: true });
    expect(widened(await everyRow(before))).toEqual(expected(EDITS, ROWS_BEFORE));

    const src = await engine.append(before, [THIRD]);
    await indexed(src);

    // Same id, longer by the third part's rows.
    expect(src.id).toBe(before.id);
    expect(src.opened.name).toBe(NAME);
    expect(src.opened.link, "several files have no one path to link to").toBeUndefined();
    expect(src.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });
    expect(src.opened.columns).toEqual(sales.columns);

    // `opened.parts` lists the files in order, before and after.
    const told = (count: number) =>
      PART_NAMES.slice(0, count).map((name, i) => ({ name, path: PART_FIXTURES[i] }));
    expect(before.opened.parts).toEqual(told(OPENED));
    expect(src.opened.parts).toEqual(told(PARTS));

    // The log is unchanged.
    expect(made(src.opened.edits)).toEqual(made(EDITS));

    // Earlier rows and edits are unchanged. The third part's rows follow.
    expect(widened(await everyRow(src))).toEqual(expected(EDITS));
    for (const e of EDITS) {
      expect((await src.rows(e.row, 1)).rows[0]![UNITS]).toBe(e.now);
      expect((await src.rows(e.row + 1, 1)).rows[0]![UNITS]).toBe(sales.raw(e.row + 1, UNITS));
    }
  } finally {
    done();
  }
});

test("a save after an append records the longer list of parts, and reopens the same", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "uno-append-")), UNO);
  const first = connect(TINY, multiProviders());
  let rows: string[][];
  try {
    const src = await first.engine.append(await edited(first.engine), [THIRD]);
    await indexed(src);
    // Still in transform mode. A row of the appended part is edited.
    await src.edit({ op: Op.Set, row: LATER.row, col: UNITS, now: LATER.now });
    rows = await everyRow(src);
    expect(widened(rows)).toEqual(expected([...EDITS, LATER]));
    await writeFile(file, await first.engine.save({ source: src.id, cells: [], at: file }, ROOMY));
  } finally {
    first.done();
  }

  const { engine, done } = connect(TINY, multiProviders());
  try {
    const src = await openOne(engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    expect(made(src.opened.edits)).toEqual(made([...EDITS, LATER]));
    expect(await everyRow(src)).toEqual(rows);

    // The save lists all three parts in order, and the log in order.
    const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
    const doc = readContainer(UNO, again, file);
    expect(doc.sources[0]!.parts!.map((p) => [p.name, p.path, p.bytes])).toEqual(
      PART_NAMES.map((name, i) => [name, PART_FIXTURES[i], partBytes[i]!.length]),
    );
    expect(doc.sources[0]).toMatchObject({ id: NAME, header: "first", rows: ROWS });
    expect(made(doc.log.map((l) => l.edit))).toEqual(made([...EDITS, LATER]));
  } finally {
    done();
  }
});

// An append leaves the workspace log as it was, so undo takes back the last
// edit made before it.
test("an append leaves the log where it was among the workspace's sources", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const whole = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    await indexed(whole);
    const before = await edited(engine);
    await whole.edit({ op: Op.Set, row: 0, col: UNITS, now: "1" });

    const src = await engine.append(before, [THIRD]);
    await indexed(src);

    const place = { source: src.id, cells: [], at: "" };
    const log = readContainer(UNO, await engine.save(place, ROOMY)).log;
    expect(log.map((l) => l.source)).toEqual([...EDITS.map(() => src.id), whole.id]);

    // Undo takes back the last edit. The others stay.
    const last = EDITS.at(-1)!;
    expect((await src.undo()).edit).toMatchObject({ row: last.row, now: last.now });
    expect((await src.rows(last.row, 1)).rows[0]![UNITS]).toBe(sales.raw(last.row, UNITS));
    expect(widened(await everyRow(src))).toEqual(expected(EDITS.slice(0, -1)));
  } finally {
    done();
  }
});

// ------------------------------------------------------------ refused

test("an append to a source that is one file is refused", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const whole = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    await indexed(whole);
    await expect(engine.append(whole, [THIRD])).rejects.toThrow(
      "sales-q3.csv is one file · files are appended only to several read as one",
    );
    expect(whole.progress.rows).toBe(ROWS);
    expect(widened((await whole.rows(0, PAGE)).rows)).toEqual(sheetRows(sales, 0, PAGE, "raw"));
  } finally {
    done();
  }
});

/** The third part with its units column renamed to qty. */
function renamed(): Uint8Array {
  const text = new TextDecoder().decode(partBytes[OPENED]!);
  return new TextEncoder().encode(text.replace("units", "qty"));
}

// An appended part must have the first part's header.
test("a part that does not agree is refused naming it and the column, and the source is as it was", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-append-"));
  const other = join(dir, PART_NAMES[OPENED]!);
  await writeFile(other, renamed());

  const { engine, done } = connect(TINY, multiProviders());
  try {
    const src = await edited(engine);
    await expect(engine.append(src, [{ name: PART_NAMES[OPENED]!, path: other }])).rejects.toThrow(
      `${PART_NAMES[OPENED]} (part ${PARTS} of ${PARTS}): column ${UNITS + 1} is "qty" where ${PART_NAMES[0]} has "units"`,
    );

    // Still two parts, every edit kept, and edits still taken.
    expect(widened(await everyRow(src))).toEqual(expected(EDITS, ROWS_BEFORE));
    await src.edit({ op: Op.Set, row: 0, col: UNITS, now: "3" });
    const doc = readContainer(UNO, await engine.save({ source: src.id, cells: [], at: "" }, ROOMY));
    expect(doc.sources[0]!.parts).toHaveLength(OPENED);
    expect(doc.log).toHaveLength(EDITS.length + 1);

    // A matching part is still accepted afterwards.
    const longer = await engine.append(src, [THIRD]);
    await indexed(longer);
    expect(longer.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});

test("a file the source already reads is refused, and so is one given twice", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const src = await edited(engine);
    await expect(engine.append(src, [part(1)])).rejects.toThrow(
      `${PART_NAMES[1]} is already part 2 of ${NAME}`,
    );
    await expect(engine.append(src, [THIRD, THIRD])).rejects.toThrow(
      `${PART_NAMES[OPENED]} is given twice to append to ${NAME}`,
    );
    await expect(engine.append(src, [])).rejects.toThrow(`no file was given to append to ${NAME}`);
    expect(src.progress.rows).toBe(ROWS_BEFORE);
    expect(widened(await everyRow(src))).toEqual(expected(EDITS, ROWS_BEFORE));
  } finally {
    done();
  }
});
