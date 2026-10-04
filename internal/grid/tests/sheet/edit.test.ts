import { describe, expect, test } from "vite-plus/test";

import { NO_ROW, Op, Sheet } from "../../src/sheet/index.ts";
import type { Edit } from "../../src/sheet/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";

const REGION = 1;
const UNITS = 2;

// Returns a fresh sheet each call because the operations mutate in place.
function fixture(): Sheet {
  return new Sheet(
    "sales.csv",
    ["date", "region", "units"],
    [
      ["2026-07-01", "West", "1,204"],
      ["2026-07-01", "East", "987"],
      ["2026-07-02", "North", "1,455"],
    ],
  );
}

// A set edit records the value it replaced in `was`.
test("set records the value it replaced", () => {
  const s = fixture();
  s.set(0, UNITS, "1204");

  expect(s.raw(0, UNITS)).toBe("1204");

  const log = s.edits();
  expect(log).toHaveLength(1);
  expect(log[0]).toEqual({ seq: 1, op: Op.Set, row: 0, col: UNITS, was: "1,204", now: "1204" });
});

// edits() returns a copy of the log.
test("edits does not alias the log", () => {
  const s = fixture();
  s.set(0, UNITS, "1204");

  const snapshot = s.edits();
  s.set(1, UNITS, "987!");

  expect(snapshot).toHaveLength(1);
  expect(s.editCount()).toBe(2);
});

// The column kind and flag are re-inferred as each edit lands.
test("fixing the last bad value clears the flag", () => {
  const s = fixture();
  expect(s.columns[UNITS]!.kind).toBe("text");
  expect(s.columns[UNITS]!.flagged).toBe(true);

  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");

  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
  expect(s.columns[UNITS]!.header, "re-inferring lost the header").toBe("units");
});

// Setting a cell past the end of a short row pads the row with empty cells.
test("set grows a short row", () => {
  const s = new Sheet("ragged.csv", ["a", "b", "c"], [["1"], ["2", "3", "4"]]);

  s.set(0, 2, "filled");

  expect(s.raw(0, 2)).toBe("filled");
  expect(s.raw(0, 1), "the padded cell").toBe("");
});

// replay applies the edits and keeps them in the log, so later edits continue
// the seq numbering.
test("replay rebuilds and keeps the log", () => {
  const edits: Edit[] = [
    { seq: 1, op: Op.Set, row: 0, col: UNITS, was: "1,204", now: "1204" },
    { seq: 2, op: Op.Set, row: 2, col: UNITS, was: "1,455", now: "1455" },
  ];

  const s = fixture();
  s.replay(edits);

  expect(s.raw(0, UNITS)).toBe("1204");
  expect(s.editCount()).toBe(2);

  s.set(1, UNITS, "986");
  expect(s.edits()[2]!.seq, "seq carries on after a replay").toBe(3);
});

// replay throws on an edit that names a cell outside the sheet, or an
// unknown operation.
describe("replay refuses a log that does not fit", () => {
  const cases: Array<[string, Edit]> = [
    ["row past the end", { seq: 1, op: Op.Set, row: 9, col: 0, now: "x" }],
    ["column past the end", { seq: 1, op: Op.Set, row: 0, col: 9, now: "x" }],
    ["unknown operation", { seq: 1, op: "rule" as Op, row: 0, col: 0, now: "x" }],
  ];

  for (const [name, e] of cases) {
    test(name, () => {
      expect(() => fixture().replay([e])).toThrow();
    });
  }
});

// apply rewrites every cell in the column and records one log entry holding
// the program text.
test("apply writes one operation for a whole column", () => {
  const s = fixture();
  s.apply(UNITS, parseProgram('replace(/,/, "")'));

  expect(s.raw(0, UNITS)).toBe("1204");
  expect(s.raw(1, UNITS)).toBe("987");
  expect(s.raw(2, UNITS)).toBe("1455");

  const log = s.edits();
  expect(log).toHaveLength(1);
  expect(log[0]).toEqual({
    seq: 1,
    op: Op.Apply,
    row: NO_ROW,
    col: UNITS,
    now: 'replace(/,/, "")',
  });
});

// apply re-infers the column kind and flag when it lands.
test("applying a program renames the column", () => {
  const s = fixture();
  expect(s.columns[UNITS]!.flagged).toBe(true);

  s.apply(UNITS, parseProgram('replace(/,/, "")'));

  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
});

// apply skips rows shorter than the column and keeps their length.
test("apply skips rows without the column", () => {
  const s = new Sheet(
    "ragged.csv",
    ["date", "region", "units"],
    [["2026-07-01", "West", "1,204"], ["2026-07-01"]],
  );

  s.apply(UNITS, parseProgram('replace(/,/, "")'));

  expect(s.raw(0, UNITS)).toBe("1204");
  expect(s.rows()).toBe(2);
  expect(s.raw(1, UNITS), "the short row grew a cell").toBe("");
});

// Replaying a log with an apply entry produces the same column values and kind.
test("replay rebuilds an applied column", () => {
  const s = fixture();
  s.set(1, UNITS, "9,870");
  s.apply(UNITS, parseProgram('replace(/,/, "")'));

  const rebuilt = fixture();
  rebuilt.replay(s.edits());

  for (let row = 0; row < s.rows(); row++) {
    expect(rebuilt.raw(row, UNITS), `row ${row}`).toBe(s.raw(row, UNITS));
  }
  expect(rebuilt.columns[UNITS]!.kind).toBe("num");
  expect(rebuilt.columns[UNITS]!.flagged).toBe(false);
});

// apply leaves a cell alone when running the program on its original value
// gives the current value. Otherwise it rewrites the current value. The same
// holds on replay.
test("apply leaves a cell it would have fixed the same way, and rewrites one it would not", () => {
  const s = fixture();
  s.set(0, REGION, "West-q3");
  s.set(1, REGION, "Eas");
  s.set(1, REGION, "East-q3"); // the net change is still East to East-q3
  s.set(2, REGION, "N");
  s.apply(REGION, parseProgram('concat(slice(0, len), "-q3")'));

  expect(s.raw(0, REGION)).toBe("West-q3");
  expect(s.raw(1, REGION)).toBe("East-q3");
  expect(s.raw(2, REGION), "N is not what the program makes of North").toBe("N-q3");

  const rebuilt = fixture();
  rebuilt.replay(s.edits());
  for (let row = 0; row < s.rows(); row++) {
    expect(rebuilt.raw(row, REGION), `row ${row} after replay`).toBe(s.raw(row, REGION));
  }
});

// replay throws on a malformed program, before changing any cell.
test("replay refuses a program it cannot read", () => {
  const s = fixture();
  expect(() =>
    s.replay([{ seq: 1, op: Op.Apply, row: NO_ROW, col: UNITS, now: "explode()" }]),
  ).toThrow();
  expect(s.raw(0, UNITS), "the cell should be untouched").toBe("1,204");
});

// When replay fails partway, the edits applied before the failure stay in the
// log, so the sheet's values and its log agree.
test("a replay that fails partway keeps the edits it folded", () => {
  const s = fixture();
  expect(() =>
    s.replay([
      { seq: 1, op: Op.Set, row: 0, col: UNITS, was: "1,204", now: "1204" },
      { seq: 2, op: Op.Set, row: 9, col: UNITS, now: "x" },
    ]),
  ).toThrow();

  expect(s.editCount()).toBe(1);
  expect(s.raw(0, UNITS)).toBe("1204");
  expect(s.edits().map((e) => e.seq)).toEqual([1]);
});

// A log longer than the maximum argument count of a spread call.
const LONG_LOG = 200_000;

test("replay takes a log longer than a call can spread", () => {
  const s = fixture();
  const edits: Edit[] = Array.from({ length: LONG_LOG }, (_, i) => ({
    seq: i + 1,
    op: Op.Set,
    row: i % s.rows(),
    col: UNITS,
    now: `${i}`,
  }));

  s.replay(edits);
  expect(s.editCount()).toBe(LONG_LOG);
  const last = LONG_LOG - 1 - ((LONG_LOG - 1) % s.rows()); // the last edit into row 0
  expect(s.raw(0, UNITS)).toBe(`${last}`);
});

// Performance check: a set re-reads only its own row.
const WIDE = 20;
const TALL = 5000;
const SETS = 1000;
/** Time budget in milliseconds for SETS sets. */
const SETS_BUDGET = 400;

test("a set costs its own row, not the sheet", () => {
  const header = Array.from({ length: WIDE }, (_, c) => `c${c}`);
  const rows = Array.from({ length: TALL }, (_, r) =>
    Array.from({ length: WIDE }, (_, c) => `${r * WIDE + c}`),
  );
  const s = new Sheet("wide.csv", header, rows);

  const began = performance.now();
  for (let i = 0; i < SETS; i++) s.set(i % TALL, i % WIDE, `v${i}`);
  const ms = performance.now() - began;

  expect(s.raw(0, 0)).toBe("v0");
  expect(ms).toBeLessThan(SETS_BUDGET);
});
