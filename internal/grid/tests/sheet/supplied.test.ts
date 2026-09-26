// A supplied column: one whoever holds the rows fills in as it reads them,
// like the `_file` column of several files read as one. The schema stores
// nothing for it, and the pipeline writes into each row what it is handed.

import { describe, expect, test } from "vite-plus/test";

import { ERR_CELL, NO_ROW, Op, Schema, finishRows } from "../../src/sheet/index.ts";
import type { Edit } from "../../src/sheet/index.ts";

const UNITS = 1;
const DOUBLE = 2;
const FILE = 3;

const HEADERS = ["region", "units", "double", "_file"];

/** Rows as a file gives them: one short, and one with a field too many. */
const SOURCES = [["West", "4"], ["East", "5", "", "left over", "and more"], ["North"]];

const FILES = ["a.csv", "a.csv", "b.csv"];

const REFUSAL = "edit 1: _file shows which file each row came from, so it cannot be changed";

function schema(): Schema {
  return new Schema(HEADERS, SOURCES.length, { col: FILE, shows: "which file each row came from" });
}

function edit(op: Edit["op"], col: number, now: string, row: number = NO_ROW): Edit {
  return { seq: 0, op, row, col, now };
}

describe("a supplied column", () => {
  test("is filled in every row under an empty log, whatever the source has there", () => {
    const finished = finishRows(schema(), 0, SOURCES, FILES);
    expect(finished.map((f) => f.shown)).toEqual([
      ["West", "4", "", "a.csv"],
      ["East", "5", "", "a.csv"],
      ["North", "", "", "b.csv"],
    ]);
    // Nothing shows that is not what the row reads as, so no row is sent twice.
    for (const f of finished) expect(f.raw).toBe(f.shown);
  });

  test("stays what it was handed beside a typed cell and a formula", () => {
    const s = schema();
    s.record(edit(Op.Set, UNITS, "9", 2));
    s.record(edit(Op.Bind, DOUBLE, "units * 2"));
    expect(finishRows(s, 0, SOURCES, FILES).map((f) => f.shown)).toEqual([
      ["West", "4", "8", "a.csv"],
      ["East", "5", "10", "a.csv"],
      ["North", "9", "18", "b.csv"],
    ]);
  });

  test("can be named by a formula, which reads what it shows", () => {
    const s = schema();
    s.record(edit(Op.Bind, DOUBLE, "_file * 2"));
    // A file's name is no number, and the formula says so in every row.
    expect(finishRows(s, 0, SOURCES, FILES).map((f) => f.shown[DOUBLE])).toEqual(
      SOURCES.map(() => ERR_CELL),
    );
  });

  test("refuses every operation on it, and is left as it was", () => {
    const s = schema();
    const cases: Array<[Edit["op"], string, number]> = [
      [Op.Set, "c.csv", 0],
      [Op.Note, "x^2", 0],
      [Op.Apply, "trim", NO_ROW],
      [Op.Bind, "units * 2", NO_ROW],
      [Op.Unbind, "", NO_ROW],
    ];
    for (const [op, now, row] of cases) {
      expect(() => s.record(edit(op, FILE, now, row)), op).toThrow(REFUSAL);
    }
    expect(s.empty).toBe(true);
  });

  test("is not in a schema that was given none", () => {
    const plain = new Schema(HEADERS.slice(0, FILE), SOURCES.length);
    expect(finishRows(plain, 0, SOURCES, FILES).map((f) => f.shown)).toEqual(SOURCES);
  });
});
