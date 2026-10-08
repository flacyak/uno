// What the engine shows of a file that is not plain UTF-8: a byte order mark, a
// UTF-16 export, a Windows-1252 one, a stray NUL, and a character the index
// pass cuts in half. Every row is compared with what read builds of the same
// bytes, so the two ways in agree on every cell.

import { expect, test } from "vite-plus/test";

import { Refusal } from "../../src/engine/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { openFormat, read, sniffEncoding } from "../../src/ingest/index.ts";
import { blobSource } from "../../src/store/index.ts";
import { TINY, connect, indexed, saidIn, sheetRows } from "./harness.ts";

const encoder = new TextEncoder();

/** The three bytes Excel's "CSV UTF-8" opens a file with. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** é, € and the en dash as Windows-1252 writes them: one byte each, none UTF-8. */
const E_ACUTE = 0xe9;
const EURO = 0x80;
const EN_DASH = 0x96;
const NUL = 0x00;

function bytesOf(...parts: Array<string | number[]>): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...encoder.encode(part));
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

/** UTF-16 with a byte order mark, in either byte order. */
function utf16(text: string, order: "le" | "be"): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, order === "le");
  for (let i = 0; i < text.length; i++)
    view.setUint16((i + 1) * 2, text.charCodeAt(i), order === "le");
  return out;
}

/** Every row the engine has, read in pages small enough to cross blocks. */
async function allRows(src: SourceHandle): Promise<string[][]> {
  await indexed(src);
  const out: string[][] = [];
  const page = 5;
  for (let first = 0; first < src.progress.rows; first += page) {
    out.push(...(await src.rows(first, page)).rows);
  }
  return out;
}

/** Opens one file through the engine and hands back its handle. */
async function open(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const { engine, done } = connect(TINY);
  const { sources } = await engine.open({ name, blob: new Blob([bytes]) });
  return { src: sources[0]!, done };
}

test("a UTF-8 byte order mark is not in the header, and not in the first row either", async () => {
  const body = "city,note\nParis,café\nBerlin,straße\n";
  const withMark = bytesOf(UTF8_BOM, body);
  const sheet = read("f.csv", withMark);
  expect(sheet.columns.map((c) => c.header)).toEqual(["city", "note"]);

  const { src, done } = await open("f.csv", withMark);
  try {
    expect(src.opened.columns.map((c) => c.header)).toEqual(["city", "note"]);
    expect(await allRows(src)).toEqual(sheetRows(sheet, 0, 2, "raw"));
  } finally {
    done();
  }

  // With no header row the mark is still no part of the first cell.
  const f = await openFormat("f.csv", blobSource(new Blob([withMark])), "none");
  expect(f.columns).toEqual(["column_1", "column_2"]);
  expect(f.dataStart).toBe(UTF8_BOM.length);
  expect(f.decode(withMark.subarray(f.dataStart))[0]).toEqual(["city", "note"]);
});

test("a character the index pass cuts in half is whole in its cell", async () => {
  // Rows wide enough that 4 KB chunks fall inside a cell, over and over.
  const lines = Array.from({ length: 400 }, (_, i) => `${i},${"é".repeat(37)}€${"ß".repeat(11)}`);
  const body = bytesOf(`n,text\n${lines.join("\n")}\n`);
  const sheet = read("f.csv", body);
  const { src, done } = await open("f.csv", body);
  try {
    const rows = await allRows(src);
    expect(rows.length).toBe(400);
    expect(rows).toEqual(sheetRows(sheet, 0, 400, "raw"));
    expect(rows.every((r) => !r[1]!.includes("�"))).toBe(true);
  } finally {
    done();
  }
});

for (const order of ["le", "be"] as const) {
  test(`a UTF-16 ${order} file is refused in words, the same way both ways in`, async () => {
    const bytes = utf16("a,b\n1,2\n", order);
    const name = `UTF-16 ${order === "le" ? "little" : "big"}-endian`;
    expect(sniffEncoding(bytes)).toBe(`utf-16${order}`);
    expect(() => read("f.csv", bytes)).toThrow(`f.csv: ${name} is not supported yet`);
    await expect(openFormat("f.csv", blobSource(new Blob([bytes])))).rejects.toThrow(
      `f.csv: ${name} is not supported yet`,
    );

    const { engine, done } = connect(TINY);
    try {
      await expect(engine.open({ name: "f.csv", blob: new Blob([bytes]) })).rejects.toThrow(
        `f.csv: ${name} is not supported yet`,
      );
    } finally {
      done();
    }
  });
}

test("a Windows-1252 file shows its characters, and says what it is", async () => {
  const body = bytesOf(
    "city;price;note\nParis;12",
    [E_ACUTE],
    ";caf",
    [E_ACUTE],
    " ",
    [EURO, EN_DASH],
    "\n",
  );
  const sheet = read("f.csv", body);
  expect(sheet.raw(0, 2)).toBe("café €–");
  expect(sheet.source).toBe("Windows-1252 · delimiter ';'");

  const { src, done } = await open("f.csv", body);
  try {
    expect(saidIn(src.opened.label)).toBe("Windows-1252 · delimiter ';'");
    expect(src.opened.columns.map((c) => c.header)).toEqual(["city", "price", "note"]);
    expect(await allRows(src)).toEqual([["Paris", "12é", "café €–"]]);
    expect(
      await src.find({ col: 2, from: -1, dir: 1, match: { t: "text", text: "é" } }),
    ).toMatchObject({
      row: 0,
    });
  } finally {
    done();
  }
});

test("a UTF-8 header over Windows-1252 rows opens, with every row in its place", async () => {
  const body = bytesOf("ville,prénom\nParis,Ren", [E_ACUTE], "\nLyon,Zo", [E_ACUTE], "\n");
  const sheet = read("f.csv", body);
  const { src, done } = await open("f.csv", body);
  try {
    const rows = await allRows(src);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r[0])).toEqual(["Paris", "Lyon"]);
    expect(rows).toEqual(sheetRows(sheet, 0, 2, "raw"));
  } finally {
    done();
  }
});

test("a NUL in a UTF-8 file is a byte in its cell, and does not make the file UTF-16", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i},row ${i} of the export`);
  const body = bytesOf(`id,blob\n${lines.join("\n")}\n0,a`, [NUL], "b\n");
  expect(sniffEncoding(body)).toBe("utf-8");
  const sheet = read("f.csv", body);
  expect(sheet.raw(50, 1)).toBe("a\0b");

  const { src, done } = await open("f.csv", body);
  try {
    expect(saidIn(src.opened.label)).toBe("UTF-8 · delimiter ','");
    const rows = await allRows(src);
    expect(rows.length).toBe(51);
    expect(rows[50]).toEqual(["0", "a\0b"]);
  } finally {
    done();
  }
});

test("a refusal through the engine is said as the engine says things", () => {
  expect(new Refusal({ t: "file-closed" })).toBeInstanceOf(Error);
});
