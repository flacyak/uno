// The engine and a .uno: opening one with its log applied, and saving back.

import { expect, test } from "vite-plus/test";

import { newManifest, readDocument, writeDocument } from "../../src/document/index.ts";
import { read } from "../../src/ingest/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { COLS, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, bytes, connect } from "./harness.ts";

/** A save limit the 240 KB fixture fits under, and one it does not. */
const ROOMY = 1 << 20;
const CRAMPED = 1 << 10;

test("a .uno opens with its log applied, and saves back", async () => {
  const saved = read("sales-q3.csv", bytes);
  saved.set(0, UNITS, "1204");
  saved.apply(UNITS, parseProgram('replace(/,/, "")'));
  const uno = writeDocument({
    manifest: { ...newManifest("sales-q3.csv"), sheet: { rows: ROWS, cols: COLS, entry: "" } },
    raw: bytes,
    state: { active: { row: 0, col: 0 } },
    edits: saved.edits(),
    extra: new Map(),
  });

  const { engine, done } = connect();
  try {
    const opened = await engine.open({ name: "q3.uno", blob: new Blob([new Uint8Array(uno)]) });
    expect(opened.name).toBe("sales-q3.csv");
    expect(opened.edits).toHaveLength(2);
    expect(opened.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    expect((await engine.rows(5, 1)).rows[0]![UNITS]).toBe("1101");

    engine.mode(true);
    await engine.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const back = readDocument("q3.uno", await engine.save({ row: 1, col: UNITS }, ROOMY));

    expect(back.edits).toHaveLength(3);
    expect(back.raw).toEqual(bytes);
    expect(back.state.active).toEqual({ row: 1, col: UNITS });
    expect(back.sheet!.raw(1, UNITS)).toBe("986");
    expect(back.sheet!.raw(5, UNITS)).toBe("1101");
  } finally {
    done();
  }
});

test("a save refuses a source over its limit, by name", async () => {
  const { engine, done } = connect();
  try {
    await engine.open({ name: "sales-q3.csv", path: FIXTURE });
    await expect(engine.save({ row: 0, col: 0 }, CRAMPED)).rejects.toThrow(
      /^sales-q3\.csv is .* until it can point at the file instead$/,
    );

    const back = readDocument("sales-q3.uno", await engine.save({ row: 0, col: 0 }, ROOMY));
    expect(back.raw).toEqual(bytes);
    expect(back.manifest.sheet.rows).toBe(ROWS);
  } finally {
    done();
  }
});
