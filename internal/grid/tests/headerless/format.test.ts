// Ingest tests for files read with header mode "none": the columns are
// numbered and the first line is a data row.

import { describe, expect, test } from "vite-plus/test";

import { columnNames, openFormat, peekFormat, read } from "../../src/ingest/index.ts";
import { bytesSource } from "../../src/store/index.ts";
import { COLS, ROWS, bytes as wholeBytes } from "../testdata/sales-q3.ts";
import { BOM, COLUMNS, allRows, marked } from "./parts.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const source = (text: string) => bytesSource(encode(text));

/** sales-q3.csv read with its header, for comparing cells against. */
const whole = read("sales-q3.csv", wholeBytes);

describe("columns that a file does not name", () => {
  test("are numbered from one, in words a formula can use", () => {
    expect(columnNames(3)).toEqual(["column_1", "column_2", "column_3"]);
    expect(columnNames(0)).toEqual([]);
    expect(COLUMNS).toHaveLength(COLS);
  });
});

describe("a format read with no header row", () => {
  test("names the columns itself and starts the rows at the first line", async () => {
    const format = await openFormat("rows.csv", source("a,b,c\n1,2,3\n"), "none");
    expect(format.header).toBe("none");
    expect(format.columns).toEqual(["column_1", "column_2", "column_3"]);
    expect(format.dataStart).toBe(0);
    expect(format.decode(encode("a,b,c\n1,2,3\n"))).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("says so where it says how the bytes were read", async () => {
    expect((await openFormat("rows.csv", source("a,b\n"), "none")).label).toBe(
      "UTF-8 · delimiter ',' · no header row",
    );
    expect((await openFormat("rows.tsv", source("a\tb\n"), "none")).label).toBe(
      "UTF-8 · tab-separated · no header row",
    );
    // A file with a header is labelled by its encoding and delimiter alone.
    expect((await openFormat("rows.csv", source("a,b\n"))).label).toBe("UTF-8 · delimiter ','");
  });

  test("is as wide as its first row, however wide the rows after it are", async () => {
    const format = await openFormat("rows.csv", source("a,b\n1,2,3,4\n5\n"), "none");
    expect(format.columns).toEqual(["column_1", "column_2"]);
  });

  test("starts the rows after a byte order mark, which is not part of the first cell", async () => {
    const bytes = marked(encode("a,b\n1,2\n"));
    const format = await openFormat("rows.csv", bytesSource(bytes), "none");
    expect(format.dataStart).toBe(BOM.length);
    expect(format.columns).toEqual(["column_1", "column_2"]);
    expect(format.decode(bytes.subarray(format.dataStart))[0]).toEqual(["a", "b"]);
  });

  test("sniffs the delimiter from the rows, and takes a .tsv at its word", async () => {
    const semicolons = await openFormat("rows.csv", source("a;b;c\n1;2;3\n"), "none");
    expect(semicolons.delimiter).toBe(";");
    expect(semicolons.columns).toHaveLength(3);

    const tabs = await openFormat("rows.tsv", source("a,x\tb\n"), "none");
    expect(tabs.delimiter).toBe("\t");
    expect(tabs.columns).toHaveLength(2);
  });

  test("reads a first row with a line break inside a quoted cell as one row", async () => {
    const text = '"two\nlines",b\n1,2\n';
    const format = await openFormat("rows.csv", source(text), "none");
    expect(format.columns).toHaveLength(2);
    expect(format.dataStart).toBe(0);
    expect(format.decode(encode(text))).toEqual([
      ["two\nlines", "b"],
      ["1", "2"],
    ]);
  });

  test("reads a first row longer than the head it reads first", async () => {
    /** More cells than fit in the 64 KB head openFormat reads first. */
    const WIDE = 20_000;
    const row = Array.from({ length: WIDE }, (_, i) => `cell${i}`).join(",");
    const format = await openFormat("rows.csv", source(`${row}\n1,2\n`), "none");
    expect(format.columns).toHaveLength(WIDE);
    expect(format.columns.at(-1)).toBe(`column_${WIDE}`);
  });

  test("takes one row with no line ending as one row", async () => {
    const format = await openFormat("rows.csv", source("a,b,c"), "none");
    expect(format.columns).toHaveLength(3);
    expect(format.dataStart).toBe(0);
  });

  test("refuses an empty file as it does with a header", async () => {
    await expect(openFormat("rows.csv", source(""), "none")).rejects.toThrow(
      "rows.csv: file is empty",
    );
    await expect(openFormat("rows.csv", bytesSource(BOM), "none")).rejects.toThrow(
      "rows.csv: file is empty",
    );
    expect(await peekFormat("rows.csv", source(""), "none")).toBeUndefined();
  });

  test("refuses JSON as it does with a header", async () => {
    await expect(openFormat("rows.json", source("[]"), "none")).rejects.toThrow(
      "rows.json: JSON is not supported yet",
    );
  });

  test("indexes every line of the fixture's rows as a row", async () => {
    const format = await openFormat("rows.csv", bytesSource(allRows), "none");
    const starts: number[] = [];
    format.scanner((offset) => starts.push(offset)).push(allRows.subarray(format.dataStart), 0);
    expect(starts).toHaveLength(ROWS);
    expect(starts[0]).toBe(0);
  });
});

describe("a format read with a header row", () => {
  test("is what a reader told nothing reads", async () => {
    const said = await openFormat("rows.csv", source("a,b\n1,2\n"), "first");
    const unsaid = await openFormat("rows.csv", source("a,b\n1,2\n"));
    expect(said.header).toBe("first");
    expect(unsaid.header).toBe("first");
    expect(said.columns).toEqual(["a", "b"]);
    expect(unsaid.columns).toEqual(["a", "b"]);
    expect(said.dataStart).toBe(unsaid.dataStart);
  });
});

describe("a whole file read with no header row", () => {
  test("is the rows of the same file read under its header, with numbered columns", () => {
    const sheet = read("rows.csv", allRows, "none");
    expect(sheet.columns.map((c) => c.header)).toEqual(COLUMNS);
    expect(sheet.rows()).toBe(ROWS);
    for (const row of [0, 1, ROWS >> 1, ROWS - 1]) {
      for (let col = 0; col < COLS; col++) {
        expect(sheet.raw(row, col), `row ${row}, column ${col}`).toBe(whole.raw(row, col));
      }
    }
    expect(sheet.source).toBe("UTF-8 · delimiter ',' · no header row");
  });

  test("keeps the first line that a read with a header takes for names", () => {
    expect(read("rows.csv", "a,b\n1,2\n", "none").rows()).toBe(2);
    expect(read("rows.csv", "a,b\n1,2\n").rows()).toBe(1);
  });

  test("refuses an empty file", () => {
    expect(() => read("rows.csv", "", "none")).toThrow("rows.csv: file is empty");
  });
});
