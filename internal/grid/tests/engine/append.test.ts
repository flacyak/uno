// The engine appending to several files read as one: parts added at the end
// of a source that is already open and already edited.
//
// The log names rows by number, so the one place a part may be added is the
// end, where every row the source had keeps its number. The rows extend, the
// log is not touched, and each edit stays on the cell it was made to, in the
// source as it is open and in the .uno a save writes of it.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import type { Engine, SourceHandle, SourceRef } from "../../src/engine/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import type { SingleRef } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
  partBytes,
} from "../testdata/sales-q3-parts.ts";
import { FIXTURE, TINY, connect, indexed, openOne, sales, sheetRows, widened } from "./harness.ts";

/** What the parts are called as one source. */
const NAME = "sales-q3";

/** What the workspace is saved as. */
const UNO = "q3.uno";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** More than any source here would need a save to carry. */
const ROOMY = 1 << 20;

/** How many parts the source is opened with, the rest being appended. */
const OPENED = PARTS - 1;

/** How many rows the source has before the append. */
const ROWS_BEFORE = PART_ROWS * OPENED;

/** A cell of units in each part the source opens with, the last row it has
 * among them, and what each is changed to. */
const EDITS = [
  { row: 1, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: ROWS_BEFORE - 1, now: "4" },
];

/** A cell in the appended part, edited once it is there. */
const LATER = { row: ROWS - 1, now: "12" };

/** One part of the fixture as a file on disk. */
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

/** The places a part can be here, and over them several read as one. */
function providers(): Provider[] {
  const single = [diskProvider(), blobProvider()];
  return [...single, multiProvider(single)];
}

/** Every row of a source, as it shows them. */
async function every(src: SourceHandle): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += PAGE) {
    rows.push(...(await src.rows(first, PAGE)).rows);
  }
  return rows;
}

/** The whole file's rows with `edits` made to its units. */
function expected(edits: ReadonlyArray<{ row: number; now: string }>, rows = ROWS): string[][] {
  const all = sheetRows(sales, 0, rows, "raw");
  for (const e of edits) all[e.row]![UNITS] = e.now;
  return all;
}

/** The first parts open as one source, in transform, with `EDITS` made. */
async function edited(engine: Engine): Promise<SourceHandle> {
  const src = await openOne(engine, FIRST_TWO);
  await indexed(src);
  engine.mode(true);
  for (const e of EDITS) await src.edit({ op: Op.Set, row: e.row, col: UNITS, now: e.now });
  return src;
}

/** What a log holds, as the rows it names and what each was changed to. */
function made(edits: ReadonlyArray<{ row: number; now: string }>): Array<[number, string]> {
  return edits.map((e) => [e.row, e.now]);
}

// The task's own sentence: edits made before the append still sit on the
// same cells.
test("a part appended extends the rows and leaves every edit on its cell", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const before = await edited(engine);
    expect(before.progress).toMatchObject({ rows: ROWS_BEFORE, complete: true });
    expect(widened(await every(before))).toEqual(expected(EDITS, ROWS_BEFORE));

    const src = await engine.append(before, [THIRD]);
    await indexed(src);

    // The same source, by the same id, and longer by the third part's rows.
    expect(src.id).toBe(before.id);
    expect(src.opened.name).toBe(NAME);
    expect(src.opened.link, "several files have no one path to link to").toBeUndefined();
    expect(src.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });
    expect(src.opened.columns).toEqual(sales.columns);

    // The log is the one that was made: the same edits, in the same order.
    expect(made(src.opened.edits)).toEqual(made(EDITS));

    // Every row the source had is where it was, edits and all, and the third
    // part's rows follow them as the whole file has them.
    expect(widened(await every(src))).toEqual(expected(EDITS));
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
  const first = connect(TINY, providers());
  let rows: string[][];
  try {
    const src = await first.engine.append(await edited(first.engine), [THIRD]);
    await indexed(src);
    // It is still in transform, and a row of the appended part is edited
    // like any other.
    await src.edit({ op: Op.Set, row: LATER.row, col: UNITS, now: LATER.now });
    rows = await every(src);
    expect(widened(rows)).toEqual(expected([...EDITS, LATER]));
    await writeFile(file, await first.engine.save({ source: src.id, cells: [], at: file }, ROOMY));
  } finally {
    first.done();
  }

  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    expect(made(src.opened.edits)).toEqual(made([...EDITS, LATER]));
    expect(await every(src)).toEqual(rows);

    // What was written: all three parts in order, each as the join measured
    // it, and the log in the order it was made.
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

// The log is one across the workspace, and an append takes no line out of it
// and puts none in: what is undone after it is what was done last before it.
test("an append leaves the log where it was among the workspace's sources", async () => {
  const { engine, done } = connect(TINY, providers());
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

    // The last edit made to it comes back off, and the others stay.
    const last = EDITS.at(-1)!;
    expect((await src.undo()).edit).toMatchObject({ row: last.row, now: last.now });
    expect((await src.rows(last.row, 1)).rows[0]![UNITS]).toBe(sales.raw(last.row, UNITS));
    expect(widened(await every(src))).toEqual(expected(EDITS.slice(0, -1)));
  } finally {
    done();
  }
});

// ------------------------------------------------------------ refused

test("an append to a source that is one file is refused", async () => {
  const { engine, done } = connect(TINY, providers());
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

/** The third part with its units column called something else. */
function renamed(): Uint8Array {
  const text = new TextDecoder().decode(partBytes[OPENED]!);
  return new TextEncoder().encode(text.replace("units", "qty"));
}

// An appended part is held to the first part as one the source opened with
// is, and the refusal is the same sentence.
test("a part that does not agree is refused naming it and the column, and the source is as it was", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uno-append-"));
  const other = join(dir, PART_NAMES[OPENED]!);
  await writeFile(other, renamed());

  const { engine, done } = connect(TINY, providers());
  try {
    const src = await edited(engine);
    await expect(engine.append(src, [{ name: PART_NAMES[OPENED]!, path: other }])).rejects.toThrow(
      `${PART_NAMES[OPENED]} (part ${PARTS} of ${PARTS}): column ${UNITS + 1} is "qty" where ${PART_NAMES[0]} has "units"`,
    );

    // Still the two parts, with every edit, and still taking edits.
    expect(widened(await every(src))).toEqual(expected(EDITS, ROWS_BEFORE));
    await src.edit({ op: Op.Set, row: 0, col: UNITS, now: "3" });
    const doc = readContainer(UNO, await engine.save({ source: src.id, cells: [], at: "" }, ROOMY));
    expect(doc.sources[0]!.parts).toHaveLength(OPENED);
    expect(doc.log).toHaveLength(EDITS.length + 1);

    // And the part that does agree is still taken after it.
    const longer = await engine.append(src, [THIRD]);
    await indexed(longer);
    expect(longer.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});

// A part read twice is its rows twice, which nobody asking to append means.
test("a file the source already reads is refused, and so is one given twice", async () => {
  const { engine, done } = connect(TINY, providers());
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
    expect(widened(await every(src))).toEqual(expected(EDITS, ROWS_BEFORE));
  } finally {
    done();
  }
});
