// The `_file` column of several files read as one: a column asked for when
// the source is made, whose cell says which part a row came from.
//
// Nothing stores it. Each cell is worked out from where its row starts in the
// join, so what has to hold is the two rows either side of every boundary
// between parts: the last row of one part says that part, and the first row
// of the next says the next.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";

import { MANIFEST_ENTRY, PARTS_VERSION, readContainer } from "../../src/document/index.ts";
import { FILE_COLUMN, TUNING } from "../../src/engine/index.ts";
import type { Engine, SourceHandle, SourceRef, Tuning } from "../../src/engine/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import type { HeaderMode } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { COLS, REGION, ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
  partBytes,
} from "../testdata/sales-q3-parts.ts";
import { NAMES as ROWS_ONLY_NAMES, rowsOnly } from "../headerless/parts.ts";
import { TINY, connect, indexed, openOne, sales, saidIn } from "./harness.ts";

/** What the parts are called as one source. */
const NAME = "sales-q3";

/** What the workspace is saved as. */
const UNO = "q3.uno";

/** Where the `_file` column sits: after every column the files have. */
const FILE = COLS;

/** How many rows are asked for at a time. */
const PAGE = 500;

/** More than any source here would need a save to carry. */
const ROOMY = 1 << 20;

const LF = 0x0a;
const CRLF_BYTES = 2;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

const encoder = new TextEncoder();

/** The first row of each part after the first: the row just past a boundary. */
const BOUNDARIES = Array.from({ length: PARTS - 1 }, (_, i) => (i + 1) * PART_ROWS);

/**
 * Blocks of 7 rows, none of which holds a boundary by design, and blocks of
 * 1024, where a boundary falls in the middle of one.
 */
const TUNINGS: ReadonlyArray<[string, Tuning]> = [
  ["small blocks", TINY],
  ["blocks that hold a boundary", TUNING],
];

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** The two ways a source has no `_file` column. */
const UNASKED: ReadonlyArray<[string, Asked]> = [
  ["said nothing", "unsaid"],
  ["said no", false],
];

let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  done = undefined;
});

/** The places a part can be here, and over them several read as one. */
function providers(): Provider[] {
  const single = [diskProvider(), blobProvider()];
  return [...single, multiProvider(single)];
}

/** An engine that reads disks, and several files as one. */
function engine(tuning: Tuning = TINY): Engine {
  const made = connect(tuning, providers());
  done = made.done;
  return made.engine;
}

/** Whether a ref asks for a `_file` column, or says nothing either way. */
type Asked = boolean | "unsaid";

/** The files at `paths` as one source under `names`, with a `_file` column unless said. */
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

/** `files` written into a folder of their own under `names`, and where each is. */
async function onDisk(files: readonly Uint8Array[], names: readonly string[]): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "uno-filecolumn-"));
  dirs.push(dir);
  const paths = names.map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => writeFile(path, files[i]!)));
  return paths;
}

/** Every row of a source, as it shows them. */
async function every(src: SourceHandle): Promise<string[][]> {
  const rows: string[][] = [];
  for (let first = 0; first < src.progress.rows; first += PAGE) {
    rows.push(...(await src.rows(first, PAGE)).rows);
  }
  return rows;
}

/** The `_file` cell of one row. */
async function fileOf(src: SourceHandle, row: number): Promise<string | undefined> {
  return (await src.rows(row, 1)).rows[0]![FILE];
}

/** The part of the fixture a row is in, by name. */
function partOf(row: number, names: readonly string[] = PART_NAMES): string {
  return names[Math.floor(row / PART_ROWS)]!;
}

/**
 * Holds the `_file` column to the three parts of the fixture: the two rows
 * either side of each boundary, asked for alone and together, the two ends,
 * and then every row there is.
 */
async function expectParts(src: SourceHandle, names: readonly string[]): Promise<void> {
  for (const first of BOUNDARIES) {
    const last = first - 1;
    expect(await fileOf(src, last), `row ${last}, the last of its part`).toBe(partOf(last, names));
    expect(await fileOf(src, first), `row ${first}, the first of its part`).toBe(
      partOf(first, names),
    );
    // One reply across the boundary, as a viewport sitting on it asks.
    const across = (await src.rows(last, 2)).rows.map((row) => row[FILE]);
    expect(across, `rows ${last} and ${first}`).toEqual([
      partOf(last, names),
      partOf(first, names),
    ]);
  }
  expect(await fileOf(src, 0)).toBe(names[0]);
  expect(await fileOf(src, ROWS - 1)).toBe(names[PARTS - 1]);

  const rows = await every(src);
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
    // Every part but the last loses the line ending of its last row, so the
    // join gives each a newline the file does not have.
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
    // The first line of every part is a row, and it is that part's.
    await expectParts(src, ROWS_ONLY_NAMES);
  });

  test("passes over a part that gives no rows, and one of two rows", async () => {
    // The header alone, and the header over the first two rows of the second
    // part with no newline after the last.
    const header = partBytes[0]!.subarray(0, partBytes[0]!.indexOf(LF) + 1);
    const second = partBytes[1]!;
    let end = header.length;
    for (let row = 0; row < 2; row++) end = second.indexOf(LF, end) + 1;
    const two = second.subarray(0, end - CRLF_BYTES);

    const names = [PART_NAMES[0]!, "two-rows.csv", "no-rows.csv", PART_NAMES[2]!];
    const files = [partBytes[0]!, two, header, partBytes[2]!];
    const src = await openOne(engine(tuning), asOne(await onDisk(files, names), names));
    await indexed(src);

    const rows = await every(src);
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

    const rows = await every(src);
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

    // Every other cell is what it is without the column.
    const rows = await every(src);
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

    // Either side of the boundary, in a column the files do have.
    for (const row of [boundary! - 1, boundary!]) {
      await src.edit({ op: Op.Set, row, col: UNITS, now: "7" });
      const [shown] = (await src.rows(row, 1)).rows;
      expect(shown![UNITS]).toBe("7");
      expect(shown![FILE]).toBe(partOf(row));
      expect(shown![REGION]).toBe(sales.raw(row, REGION));
    }
    // The column is as it was with a log beside it, at every row.
    await expectParts(src, PART_NAMES);
  });
});

describe("a source that did not ask for a _file column", () => {
  test.each(UNASKED)("has none when it %s", async (_, fileColumn) => {
    const src = await openOne(engine(), asOne(PART_FIXTURES, PART_NAMES, "first", fileColumn));
    await indexed(src);
    expect(src.opened.columns).toEqual(sales.columns);
    for (const row of await every(src)) expect(row.length).toBeLessThanOrEqual(COLS);
  });
});

describe("a save of a source with a _file column", () => {
  /** uno.json as it was written, as text. */
  function manifestOf(uno: Uint8Array): string {
    return strFromU8(unzipSync(uno)[MANIFEST_ENTRY]!);
  }

  /** The fixture's parts in a folder of their own, opened, edited and saved beside them. */
  async function saved(fileColumn: Asked) {
    const paths = await onDisk(partBytes, PART_NAMES);
    const file = join(paths[0]!, "..", UNO);
    const e = engine();
    const src = await openOne(e, asOne(paths, PART_NAMES, "first", fileColumn));
    await indexed(src);
    e.mode(true);
    await src.edit({ op: Op.Set, row: BOUNDARIES[0]!, col: UNITS, now: "77" });
    const rows = await every(src);
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

    // The log holds the one edit, to a column the files have. A part's name
    // is in the save where the part is pointed at, and nowhere a cell would be.
    expect(doc.log.map((l) => l.edit.col)).toEqual([UNITS]);
    const entries = unzipSync(uno);
    for (const [entry, bytes] of Object.entries(entries)) {
      if (entry === MANIFEST_ENTRY) continue;
      for (const name of PART_NAMES) expect(strFromU8(bytes), entry).not.toContain(name);
    }

    // Opened again from the save alone: the column, and the edit beside it.
    const src = await openOne(engine(), { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.columns.at(-1)?.header).toBe(FILE_COLUMN);
    expect(await every(src)).toEqual(rows);
    await expectParts(src, PART_NAMES);
  });

  // The edit is in part two, so the open reaches for it and finds it gone.
  // What the source was asked to show is part of what it is, with or without
  // its files, so pointed at them again it shows the column as it did.
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
    expect(await every(src)).toEqual(rows);
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
