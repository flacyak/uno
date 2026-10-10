import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { read } from "../../src/ingest/index.ts";

import { ERR_CELL, Sheet } from "../../src/sheet/index.ts";
import { parse } from "../../src/formula/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";

const REGION = 0;
const PRICE = 1;
const COST = 2;
const MARGIN = 3;

// Returns a fresh sheet each call because bind mutates in place.
function sales(): Sheet {
  return new Sheet(
    "sales.csv",
    ["region", "price", "cost", "margin"],
    [
      ["West", "40.00", "31.20", ""],
      ["East", "40.00", "30.00", ""],
      ["North", "50.00", "25.00", ""],
    ],
  );
}

// Binding fills every row from the expression and records one log entry.
test("binding a column fills it from one line", () => {
  const s = sales();
  s.bind(MARGIN, parse("(price - cost) / price"));

  expect(["0.22", "0.25", "0.5"].map((_, row) => s.display(row, MARGIN))).toEqual([
    "0.22",
    "0.25",
    "0.5",
  ]);
  expect(s.editCount(), "the binding should be one line").toBe(1);
});

// Column kind inference trims whitespace, so "40.00\t" counts as numeric. A
// formula over that column must parse the same trimmed value.
test("a cell the badge calls numeric computes, however it is padded", () => {
  const s = new Sheet(
    "sales.csv",
    ["region", "price", "cost", "margin"],
    [
      ["West", "40.00\t", "31.20", ""],
      ["East", "\u00a040.00", "30.00\r", ""],
    ],
  );
  expect(s.columns[PRICE]!.kind).toBe("num");
  expect(s.columns[COST]!.kind).toBe("num");

  s.bind(MARGIN, parse("(price - cost) / price"));
  expect([0, 1].map((row) => s.display(row, MARGIN))).toEqual(["0.22", "0.25"]);
});

// (40.00 - 31.20) / 40.00 is 0.21999999999999997 in binary floating point.
// The displayed value is rounded.
test("a computed value is not shown with its floating point noise", () => {
  const s = sales();
  s.bind(MARGIN, parse("(price - cost) / price"));
  expect(s.display(0, MARGIN)).not.toContain("999999");
});

// Rounding keeps all significant digits a float64 carries, so a twelve-digit
// cents value divided by 100 keeps its cents.
test("a computed value keeps every digit the number has", () => {
  const s = new Sheet("ledger.csv", ["cents", "dollars"], [["123456789012", ""]]);
  s.bind(1, parse("cents / 100"));

  expect(s.display(0, 1)).toBe("1234567890.12");
});

// Editing an input cell recomputes only the rows that depend on it.
test("editing an input updates the column that reads it", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));
  const before = s.display(1, MARGIN);

  s.set(0, COST, "20.00");

  expect(s.display(0, MARGIN)).toBe("20");
  expect(s.display(1, MARGIN), "the untouched row moved").toBe(before);
});

// A binding that would form a cycle throws at bind time. The error names the
// columns in the loop and the log is left as it was.
test("a cycle is refused at bind time with the path named", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));

  let thrown: Error | undefined;
  try {
    s.bind(PRICE, parse("margin + cost"));
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown, "binding price to something reading margin was accepted").toBeDefined();
  expect(thrown!.message).toContain("margin");
  expect(thrown!.message).toContain("price");
  expect(s.editCount(), "the refused binding was recorded anyway").toBe(1);
  expect(s.display(0, PRICE), "the refusal changed something").toBe("40.00");
});

// set() throws on a bound column.
test("a cell in a bound column cannot be typed into", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));

  expect(() => s.set(0, MARGIN, "nonsense")).toThrow();
  expect(s.display(0, MARGIN)).toBe("8.8");
});

// apply() throws on a bound column, and the stored values underneath are
// untouched.
test("a program cannot run over a bound column", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));

  let thrown: Error | undefined;
  try {
    s.apply(MARGIN, parseProgram('replace(/8/, "9")'));
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown, "a program over a bound column was accepted").toBeDefined();
  expect(thrown!.message).toContain("computed by a formula");
  expect(s.editCount(), "the refused program was recorded anyway").toBe(1);
  expect(s.display(0, MARGIN)).toBe("8.8");
  s.unbind(MARGIN);
  expect(s.display(0, MARGIN), "the refused program ran over the stored values").toBe("");
});

// A row the expression fails on displays ERR_CELL.
describe("a row the expression cannot read says so", () => {
  const s = new Sheet(
    "t.csv",
    ["a", "b", "c"],
    [
      ["10", "2", ""],
      ["10", "0", ""],
      ["10", "N/A", ""],
    ],
  );
  s.bind(2, parse("a / b"));

  const cases: Array<[number, string]> = [
    [0, "5"],
    [1, ERR_CELL], // divide by zero
    [2, ERR_CELL], // text in b
  ];

  for (const [row, want] of cases) {
    test(`row ${row}`, () => {
      expect(s.display(row, 2)).toBe(want);
    });
  }
});

// A column name that matches two headers is refused.
test("an ambiguous column name is refused rather than guessed at", () => {
  const s = new Sheet("t.csv", ["total", "total", "out"], [["1", "2", ""]]);
  expect(() => s.bind(2, parse("total + 1"))).toThrow();
});

// A formula naming an unknown column throws at bind time and leaves the log
// as it was.
test("a formula naming a column that is not there is refused", () => {
  const s = sales();
  expect(() => s.bind(MARGIN, parse("price - postage"))).toThrow();
  expect(s.editCount(), "the refused binding was recorded").toBe(0);
});

// Bound columns recompute in dependency order, so a column that reads another
// bound column sees its computed value.
test("a column that reads a bound column sees what it computed", () => {
  const s = new Sheet(
    "t.csv",
    ["units", "price", "revenue", "tax"],
    [
      ["10", "3", "", ""],
      ["4", "5", "", ""],
    ],
  );
  s.bind(2, parse("units * price"));
  s.bind(3, parse("revenue / 10"));

  expect(s.display(0, 3)).toBe("3");

  // Editing the first input recomputes the whole chain.
  s.set(0, 0, "20");
  expect(s.display(0, 3)).toBe("6");
});

// Replaying the log rebuilds every computed value.
test("replay rebuilds what was computed", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));
  s.set(0, COST, "10.00");

  const replayed = sales();
  replayed.replay(s.edits());

  for (let row = 0; row < s.rows(); row++) {
    expect(replayed.display(row, MARGIN), `row ${row}`).toBe(s.display(row, MARGIN));
  }
});

// Undo is truncate-and-replay. Replaying the log cut before the binding
// leaves the column unbound and empty.
test("a binding can be undone", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));

  const undone = sales();
  undone.replay(s.edits().slice(0, 0));

  expect(undone.display(0, MARGIN)).toBe("");
  expect(undone.binding(MARGIN), "still bound after replaying the binding away").toBeUndefined();
});

// A bound column's kind is inferred from its computed values.
test("a bound column is named for what it computes", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));
  expect(s.columns[MARGIN]!.kind).toBe("num");
});

// Unbinding shows the stored values again and re-infers the column kind.
test("removing a formula gives a column its own values back", () => {
  const s = sales();
  s.bind(REGION, parse("price * 2"));
  expect(s.display(0, REGION)).toBe("80");

  s.unbind(REGION);

  expect(["West", "East", "North"].map((_, row) => s.display(row, REGION))).toEqual([
    "West",
    "East",
    "North",
  ]);
  expect(s.binding(REGION)).toBeUndefined();
  expect(s.columns[REGION]!.kind, "re-inferred from the values that came back").toBe("text");
});

// Unbinding a column recomputes the columns that read it, now from its stored
// values.
test("removing a formula recalculates what read it", () => {
  const s = sales();
  s.bind(COST, parse("price * 2"));
  s.bind(MARGIN, parse("cost + 1"));
  expect(s.display(0, MARGIN)).toBe("81");

  s.unbind(COST);

  expect(s.display(0, MARGIN)).toBe("32.2");
});

// Unbind is its own log entry, so replaying the log cut before it restores
// the binding.
test("removing a formula can be undone", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));
  s.unbind(MARGIN);
  expect(s.editCount(), "the removal should be a line of its own").toBe(2);

  const undone = sales();
  undone.replay(s.edits().slice(0, 1));

  expect(undone.display(0, MARGIN)).toBe("8.8");
});

// Unbinding an unbound column throws and leaves the log as it was.
test("removing a formula from a column that has none is refused", () => {
  const s = sales();

  let thrown: Error | undefined;
  try {
    s.unbind(MARGIN);
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown).toBeDefined();
  expect(thrown!.message, "the column should be named").toContain("margin");
  expect(s.editCount(), "a refused removal wrote a line").toBe(0);
});

// Unbind clears the computed cache, so the column can be bound again.
test("a column can be bound again after its formula is removed", () => {
  const s = sales();
  s.bind(MARGIN, parse("price - cost"));
  s.unbind(MARGIN);

  s.bind(MARGIN, parse("price + cost"));
  expect(s.display(0, MARGIN)).toBe("71.2");
});

// Replaying a log with a bind and an unbind leaves the column unbound with its
// stored values.
test("replay rebuilds a column whose formula was removed", () => {
  const s = sales();
  s.bind(REGION, parse("price * 2"));
  s.unbind(REGION);

  const replayed = sales();
  replayed.replay(s.edits());

  expect(replayed.display(0, REGION)).toBe("West");
  expect(replayed.binding(REGION)).toBeUndefined();
});

// Bound columns are computed in blocks. Every row of the full file must match
// the single-row evaluateAt result, including across block boundaries.
test("a bound column over the whole file agrees with the preview row by row", () => {
  const path = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
  const s = read("sales-q3.csv", readFileSync(path));
  const channel = s.resolve("channel");
  const f = parse("revenue / units");
  s.bind(channel, f);

  let failed = 0;
  for (let row = 0; row < s.rows(); row++) {
    let want: string;
    try {
      want = s.evaluateAt(f, row);
    } catch {
      want = ERR_CELL;
      failed++;
    }
    if (s.display(row, channel) !== want) {
      expect(s.display(row, channel), `row ${row}`).toBe(want);
    }
  }
  // Some rows of the file hold text in units, so error rows are covered too.
  expect(failed).toBeGreaterThan(0);
});
