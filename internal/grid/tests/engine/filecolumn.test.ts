// The `_file` column of several files read as one: an extra column, asked for
// in the ref, whose cell names the part a row came from. The cell is computed
// from the row's byte offset, so the checks focus on the rows either side of
// each part boundary.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";

import { MANIFEST_ENTRY, PARTS_VERSION, readContainer } from "../../src/document/index.ts";
import { FILE_COLUMN, TUNING } from "../../src/engine/index.ts";
import type { Engine, SourceHandle, SourceRef, Tuning } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import type { HeaderMode } from "../../src/store/index.ts";
import { COLS, REGION, ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
  partBytes,
} from "../testdata/sales-q3-parts.ts";
import { NAMES as ROWS_ONLY_NAMES, rowsOnly } from "../headerless/parts.ts";
import {
  connect,
  everyRow,
  indexed,
  multiProviders,
  openOne,
  saidIn,
  sales,
  TINY,
} from "./harness.ts";

/** What the parts are called as one source. */
const NAME = "sales-q3";

/** What the workspace is saved as. */
const UNO = "q3.uno";

/** The index of the `_file` column, after the files' own columns. */
const FILE = COLS;

/** A save limit larger than any carried source here. */
const ROOMY = 1 << 20;

const LF = 0x0a;
const CRLF_BYTES = 2;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

const encoder = new TextEncoder();

/** The first row of each part after the first. */
const BOUNDARIES = Array.from({ length: PARTS - 1 }, (_, i) => (i + 1) * PART_ROWS);

/**
 * Blocks of 7 rows, where every block stays inside one part, and blocks of
 * 1024, where one spans a boundary.
 */
const TUNINGS: ReadonlyArray<[string, Tuning]> = [
  ["small blocks", TINY],
  ["blocks that hold a boundary", TUNING],
];

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** The two ways a ref asks for no `_file` column. */
const UNASKED: ReadonlyArray<[string, Asked]> = [
  ["said nothing", "unsaid"],
  ["said no", false],
];

let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  done = undefined;
});

/** An engine over disk, blob and multi providers, closed after each test. */
function engine(tuning: Tuning = TINY): Engine {
  const made = connect(tuning, multiProviders());
  done = made.done;
  return made.engine;
}

/** Whether a ref asks for a `_file` column, or leaves it unsaid. */
type Asked = boolean | "unsaid";

/** A ref of `paths` as one source under `names`, with `_file` by default. */
function asOne(
  paths: readonly string[],
  names: readonly string[] = PART_NAMES,
  header: HeaderMode = "first",
  fileColumn: Asked = true,
): SourceRef {
  const parts = paths.map((path, i) => ({ ref: { name: names[i]!, path } }));
  return fileColumn === "unsaid"
    ? { name: NAME, parts, header }
    : { name: NAME, parts, header, fileColumn };
}

/** Writes `files` under `names` into a new temp folder and returns their paths. */
async function onDisk(files: readonly Uint8Array[], names: readonly string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "uno-filecolumn-"));
  dirs.push(dir);
  const paths = names.map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => writeFile(path, files[i]!)));
  return paths;
}

/** The `_file` cell of one row. */
async function fileOf(src: SourceHandle, row: number): Promise<string | undefined> {
  return (await src.rows(row, 1)).rows[0]![FILE];
}

/** The name of the part holding `row`. */
function partOf(row: number, names: readonly string[] = PART_NAMES): string {
  return names[Math.floor(row / PART_ROWS)]!;
}

/**
 * Checks the `_file` cell of the rows either side of each boundary, alone and
 * in one reply, of the first and last rows, and then of every row.
 */
async function expectParts(src: SourceHandle, names: readonly string[]): Promise<void> {
  for (const first of BOUNDARIES) {
    const last = first - 1;
    expect(await fileOf(src, last), `row ${last}, the last of its part`).toBe(partOf(last, names));
    expect(await fileOf(src, first), `row ${first}, the first of its part`).toBe(
      partOf(first, names),
    );
    // Both rows in one reply.
    const across = (await src.rows(last, 2)).rows.map((row) => row[FILE]);
    expect(across, `rows ${last} and ${first}`).toEqual([
      partOf(last, names),
      partOf(first, names),
    ]);
  }
  expect(await fileOf(src, 0)).toBe(names[0]);
  expect(await fileOf(src, ROWS - 1)).toBe(names[PARTS - 1]);

  const rows = await everyRow(src);
  expect(rows).toHaveLength(ROWS);
  expect(rows.map((row) => row[FILE])).toEqual(rows.map((_, row) => partOf(row, names)));
}

describe.each(TUNINGS)("the _file column, over %s", (_, tuning) => {
  test("says the part of every row, right at each boundary", async () => {
    const src = await openOne(engine(tuning), asOne(PART_FIXTURES));
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    await expectParts(src, PART_NAMES);
  });

  test("is right where a part's last row has no newline", async () => {
    // Every part but the last loses its final line ending.
    const cut = partBytes.map((part, i) =>
      i < PARTS - 1 ? part.subarray(0, part.length - CRLF_BYTES) : part,
    );
    for (const part of cut.slice(0, PARTS - 1)) expect(part.at(-1)).not.toBe(LF);

    const src = await openOne(engine(tuning), asOne(await onDisk(cut, PART_NAMES)));
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    await expectParts(src, PART_NAMES);
  });

  test("is right for parts with no header row", async () => {
    const paths = await onDisk(rowsOnly, ROWS_ONLY_NAMES);
    const src = await openOne(engine(tuning), asOne(paths, ROWS_ONLY_NAMES, "none"));
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    // With header mode "none", the first line of every part is a row of that
    // part.
    await expectParts(src, ROWS_ONLY_NAMES);
  });

  test("passes over a part that gives no rows, and one of two rows", async () => {
    // A header-only part, and a two-row part cut short of its final newline.
    const header = partBytes[0]!.subarray(0, partBytes[0]!.indexOf(LF) + 1);
    const second = partBytes[1]!;
    let end = header.length;
    for (let row = 0; row < 2; row++) end = second.indexOf(LF, end) + 1;
    const two = second.subarray(0, end - CRLF_BYTES);

    const names = [PART_NAMES[0]!, "two-rows.csv", "no-rows.csv", PART_NAMES[2]!];
    const files = [partBytes[0]!, two, header, partBytes[2]!];
    const src = await openOne(engine(tuning), asOne(await onDisk(files, names), names));
    await indexed(src);

    const rows = await everyRow(src);
    expect(rows).toHaveLength(PART_ROWS + 2 + PART_ROWS);
    expect(rows.map((row) => row[FILE])).toEqual([
      ...Array.from({ length: PART_ROWS }, () => names[0]),
      names[1],
      names[1],
      ...Array.from({ length: PART_ROWS }, () => names[3]),
    ]);
  });

  test("passes over a part of blank lines, and one that is a byte order mark alone", async () => {
    const names = [PART_NAMES[0]!, "blank.csv", "marked.csv", PART_NAMES[2]!];
    const files = [partBytes[0]!, encoder.encode("\n\n"), BOM, partBytes[2]!];
    const src = await openOne(engine(tuning), asOne(await onDisk(files, names), names));
    await indexed(src);

    const rows = await everyRow(src);
    expect(rows).toHaveLength(PART_ROWS + PART_ROWS);
    expect(rows.map((row) => row[FILE])).toEqual([
      ...Array.from({ length: PART_ROWS }, () => names[0]),
      ...Array.from({ length: PART_ROWS }, () => names[3]),
    ]);
  });
});

describe("a source with a _file column", () => {
  test("shows it as one more column, after the ones the files have", async () => {
    const src = await openOne(engine(), asOne(PART_FIXTURES));
    await indexed(src);
    expect(src.opened.columns.map((c) => c.header)).toEqual([
      ...sales.columns.map((c) => c.header),
      FILE_COLUMN,
    ]);
    expect(src.opened.columns.slice(0, COLS)).toEqual(sales.columns);
    expect(src.opened.columns[FILE]).toEqual({ header: FILE_COLUMN, kind: "text", flagged: false });

    // The other cells are unchanged.
    const rows = await everyRow(src);
    for (const row of [0, BOUNDARIES[0]! - 1, BOUNDARIES[0]!, ROWS - 1]) {
      expect(rows[row], `row ${row}`).toHaveLength(COLS + 1);
      expect(rows[row]!.slice(0, COLS)).toEqual(
        Array.from({ length: COLS }, (_, col) => sales.raw(row, col)),
      );
    }
  });

  test("finds a part by name in it, looking down and up", async () => {
    const src = await openOne(engine(), asOne(PART_FIXTURES));
    await indexed(src);
    const [second, third] = BOUNDARIES;
    const down = await src.find({
      col: FILE,
      from: 0,
      dir: 1,
      match: { t: "text", text: PART_NAMES[1]! },
    });
    expect(down.row).toBe(second);
    const up = await src.find({
      col: FILE,
      from: ROWS - 1,
      dir: -1,
      match: { t: "text", text: PART_NAMES[1]! },
    });
    expect(up.row).toBe(third! - 1);
  });

  test("refuses every edit to it in words, and takes edits beside it", async () => {
    const e = engine();
    const src = await openOne(e, asOne(PART_FIXTURES));
    await indexed(src);
    e.mode(true);

    const refusal = `${FILE_COLUMN} shows which file each row came from, so it cannot be changed`;
    const [boundary] = BOUNDARIES;
    for (const op of [Op.Set, Op.Note, Op.Apply, Op.Bind]) {
      await expect(src.edit({ op, row: boundary!, col: FILE, now: "x" }), op).rejects.toThrow(
        refusal,
      );
    }
    expect(await fileOf(src, boundary!)).toBe(PART_NAMES[1]);

    // Edits either side of the boundary, in a column the files have.
    for (const row of [boundary! - 1, boundary!]) {
      await src.edit({ op: Op.Set, row, col: UNITS, now: "7" });
      const [shown] = (await src.rows(row, 1)).rows;
      expect(shown![UNITS]).toBe("7");
      expect(shown![FILE]).toBe(partOf(row));
      expect(shown![REGION]).toBe(sales.raw(row, REGION));
    }
    // The column is unchanged at every row.
    await expectParts(src, PART_NAMES);
  });
});

describe("a source that did not ask for a _file column", () => {
  test.each(UNASKED)("has none when it %s", async (_, fileColumn) => {
    const src = await openOne(engine(), asOne(PART_FIXTURES, PART_NAMES, "first", fileColumn));
    await indexed(src);
    expect(src.opened.columns).toEqual(sales.columns);
    for (const row of await everyRow(src)) expect(row.length).toBeLessThanOrEqual(COLS);
  });
});

describe("a save of a source with a _file column", () => {
  /** The manifest entry of a .uno, as text. */
  function manifestOf(uno: Uint8Array): string {
    return strFromU8(unzipSync(uno)[MANIFEST_ENTRY]!);
  }

  /** Copies the parts to a folder, opens them, edits one cell, and saves there. */
  async function saved(fileColumn: Asked) {
    const paths = await onDisk(partBytes, PART_NAMES);
    const file = join(paths[0]!, "..", UNO);
    const e = engine();
    const src = await openOne(e, asOne(paths, PART_NAMES, "first", fileColumn));
    await indexed(src);
    e.mode(true);
    await src.edit({ op: Op.Set, row: BOUNDARIES[0]!, col: UNITS, now: "77" });
    const rows = await everyRow(src);
    await writeFile(file, await e.save({ source: src.id, cells: [], at: file }, ROOMY));
    done?.();
    done = undefined;
    return { file, paths, rows, uno: new Uint8Array(await readFile(file)) };
  }

  test("keeps that it was asked for, and none of what it shows", async () => {
    const { file, rows, uno } = await saved(true);

    const doc = readContainer(UNO, uno, file);
    expect(doc.manifest.format).toBe(PARTS_VERSION);
    expect(doc.sources[0]).toMatchObject({ id: NAME, fileColumn: true, rows: ROWS });
    expect(JSON.parse(manifestOf(uno)).sources[0].fileColumn).toBe(true);

    // The log holds one edit. Part names appear only in the manifest.
    expect(doc.log.map((l) => l.edit.col)).toEqual([UNITS]);
    const entries = unzipSync(uno);
    for (const [entry, bytes] of Object.entries(entries)) {
      if (entry === MANIFEST_ENTRY) continue;
      for (const name of PART_NAMES) expect(strFromU8(bytes), entry).not.toContain(name);
    }

    // Reopened from the save: the column and the edit are there.
    const src = await openOne(engine(), { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.columns.at(-1)?.header).toBe(FILE_COLUMN);
    expect(await everyRow(src)).toEqual(rows);
    await expectParts(src, PART_NAMES);
  });

  // The edit is in part two, so the open reads it and finds it gone. After
  // a relink the column is still there.
  test("keeps it through a part going missing and the source being pointed at it again", async () => {
    const { file, paths, rows } = await saved(true);
    const gone = paths[1]!;
    const bytes = await readFile(gone);
    await rm(gone);

    const e = engine();
    const absent = await openOne(e, { name: UNO, path: file });
    expect(saidIn(absent.opened.link?.missing)).toContain(PART_NAMES[1]);

    await writeFile(gone, bytes);
    const src = await e.relink(absent, asOne(paths, PART_NAMES, "first", "unsaid"));
    await indexed(src);
    expect(src.opened.columns.at(-1)?.header).toBe(FILE_COLUMN);
    expect(await everyRow(src)).toEqual(rows);
    await expectParts(src, PART_NAMES);
  });

  test.each(UNASKED)("says nothing of one for a source that %s", async (_, fileColumn) => {
    const { file, uno } = await saved(fileColumn);
    expect(manifestOf(uno)).not.toContain("fileColumn");
    expect(readContainer(UNO, uno, file).sources[0]!.fileColumn).toBeUndefined();

    const src = await openOne(engine(), { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.columns).toEqual(sales.columns);
  });
});
