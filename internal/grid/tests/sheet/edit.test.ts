import { describe, expect, test } from "vite-plus/test";

import { NO_ROW, Op, Sheet } from "../../src/sheet/index.ts";
import type { Edit } from "../../src/sheet/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";

const REGION = 1;
const UNITS = 2;

// A fresh sheet each call, since the operations mutate in place.
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

// An edit records what it replaced, which is what makes it readable on its own
// and reversible without re-reading the source.
test("set records the value it replaced", () => {
  const s = fixture();
  s.set(0, UNITS, "1204");

  expect(s.raw(0, UNITS)).toBe("1204");

  const log = s.edits();
  expect(log).toHaveLength(1);
  expect(log[0]).toEqual({ seq: 1, op: Op.Set, row: 0, col: UNITS, was: "1,204", now: "1204" });
});

// edits() is handed to whatever writes it while the person keeps typing, so it
// must not alias the log the sheet goes on appending to.
test("edits does not alias the log", () => {
  const s = fixture();
  s.set(0, UNITS, "1204");

  const snapshot = s.edits();
  s.set(1, UNITS, "987!");

  expect(snapshot).toHaveLength(1);
  expect(s.editCount()).toBe(2);
});

// Fixing the last unparseable value in a column is what clears its warning
// badge, so the kind is re-inferred as the edit lands rather than at the next
// open.
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

// Ragged rows are normal in real exports. Editing a cell past the end of its
// row has to create it rather than be swallowed by raw's tolerance of short rows.
test("set grows a short row", () => {
  const s = new Sheet("ragged.csv", ["a", "b", "c"], [["1"], ["2", "3", "4"]]);

  s.set(0, 2, "filled");

  expect(s.raw(0, 2)).toBe("filled");
  expect(s.raw(0, 1), "the padded cell").toBe("");
});

// Replay is how a .uno rebuilds itself, and it must keep the log it replayed so
// that saving a reopened file preserves the history rather than starting a new
// one.
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

// A log that names a cell this sheet does not have is a log that does not
// belong to these bytes, and opening must say so rather than build a wrong grid.
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

// The point of a column op is that the log grows with what a person did and not
// with how much data they did it to. Three cells change and one line is written.
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

// Fixing a whole column is what clears its warning badge, and the kind has to
// be re-read as the operation lands rather than at the next open.
test("applying a program renames the column", () => {
  const s = fixture();
  expect(s.columns[UNITS]!.flagged).toBe(true);

  s.apply(UNITS, parseProgram('replace(/,/, "")'));

  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
});

// A transform rewrites values that are there. A row that never had this column
// has no value to be wrong about, and inventing an empty cell would change the
// shape of the data on the strength of an inference.
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

// Undo replays, and a column op is the case that mechanism exists for: there is
// no old value to put back, so the rebuild has to produce the same column the
// operation did the first time.
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

// The recogniser learns a program from cells a person fixed, and those were
// typed before the apply that follows. Running a program that is not idempotent
// over them again would fix them twice: West-q3 would read West-q3-q3.
test("apply leaves a cell it would have fixed the same way, and rewrites one it would not", () => {
  const s = fixture();
  s.set(0, REGION, "West-q3");
  s.set(1, REGION, "Eas");
  s.set(1, REGION, "East-q3"); // a slip on the way is still East to East-q3
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

// A log naming a program this build cannot read has to fail before a single
// cell moves. Refusing to open a workspace is recoverable; half-transforming
// one is not.
test("replay refuses a program it cannot read", () => {
  const s = fixture();
  expect(() =>
    s.replay([{ seq: 1, op: Op.Apply, row: NO_ROW, col: UNITS, now: "explode()" }]),
  ).toThrow();
  expect(s.raw(0, UNITS), "the cell should be untouched").toBe("1,204");
});

// A log that fails partway has edits before the failure that were valid, and
// the Schema has already folded them. They are kept in the log too, so what
// the sheet shows and what it would save agree: a folded write the log does
// not hold would come back the moment any later edit made the log non-empty.
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

// A column pasted in a cell at a time is one line per cell, and a log that
// long is longer than a call can take as arguments.
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

// Typing into one cell reaches one row, and should cost about that. Before
// this budget a set threw away every finished row and re-read a sample of
// every column, so a paste of a thousand cells into a wide sheet took seconds.
const WIDE = 20;
const TALL = 5000;
const SETS = 1000;
/** Milliseconds for SETS sets. The old way took over two thousand. */
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
