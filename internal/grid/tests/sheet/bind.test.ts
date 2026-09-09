import { describe, expect, test } from "vite-plus/test";

import { ERR_CELL, Sheet } from "../../src/sheet/index.ts";
import { parse } from "../../src/formula/index.ts";

// A fresh sheet each call, since binding mutates in place.
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

// A bound column computes every row from the columns its expression names, and
// it does so from one recorded line rather than from three stored values. That
// ratio is the whole argument for storing the expression instead of the results.
test("binding a column fills it from one line", () => {
  const s = sales();
  s.bind(3, parse("(price - cost) / price"));

  expect(["0.22", "0.25", "0.5"].map((_, row) => s.display(row, 3))).toEqual([
    "0.22",
    "0.25",
    "0.5",
  ]);
  expect(s.editCount(), "the binding should be one line").toBe(1);
});

// Binary floating point makes (40.00 - 31.20) / 40.00 into 0.21999999999999997,
// and a column of those is arithmetic showing its working rather than answering.
test("a computed value is not shown with its floating point noise", () => {
  const s = sales();
  s.bind(3, parse("(price - cost) / price"));
  expect(s.display(0, 3)).not.toContain("999999");
});

// Editing an input recomputes what reads it. Nothing else moves, because the
// walk is over what is downstream of the change rather than over the sheet.
test("editing an input updates the column that reads it", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));
  const before = s.display(1, 3);

  s.set(0, 2, "20.00");

  expect(s.display(0, 3)).toBe("20");
  expect(s.display(1, 3), "the untouched row moved").toBe(before);
});

// A cycle is refused where a person can still do something about it, and the
// error names the loop rather than reporting that one exists.
test("a cycle is refused at bind time with the path named", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));

  let thrown: Error | undefined;
  try {
    s.bind(1, parse("margin + cost"));
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown, "binding price to something reading margin was accepted").toBeDefined();
  expect(thrown!.message).toContain("margin");
  expect(thrown!.message).toContain("price");
  expect(s.editCount(), "the refused binding was recorded anyway").toBe(1);
  expect(s.display(0, 1), "the refusal changed something").toBe("40.00");
});

// A derived column stores nothing, so typing into one would be typing something
// the next recalculation discards without saying so.
test("a cell in a bound column cannot be typed into", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));

  expect(() => s.set(0, 3, "nonsense")).toThrow();
  expect(s.display(0, 3)).toBe("8.8");
});

// A row the expression cannot read says so in the cell it happened in. An empty
// cell would read as missing data, which is a different thing entirely.
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
    [2, ERR_CELL], // not a number
  ];

  for (const [row, want] of cases) {
    test(`row ${row}`, () => {
      expect(s.display(row, 2)).toBe(want);
    });
  }
});

// An expression names columns the way a person does, so a name that means two
// columns means nothing the graph can reason about.
test("an ambiguous column name is refused rather than guessed at", () => {
  const s = new Sheet("t.csv", ["total", "total", "out"], [["1", "2", ""]]);
  expect(() => s.bind(2, parse("total + 1"))).toThrow();
});

// A formula naming a column that is not there is refused before anything is
// computed, rather than filling 4,812 rows with a failure.
test("a formula naming a column that is not there is refused", () => {
  const s = sales();
  expect(() => s.bind(3, parse("price - postage"))).toThrow();
  expect(s.editCount(), "the refused binding was recorded").toBe(0);
});

// A chain recomputes in dependency order, so a column that reads a bound column
// reads the value it computed and not the empty cell underneath it.
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

  // And the chain holds when the far end of it moves.
  s.set(0, 0, "20");
  expect(s.display(0, 3)).toBe("6");
});

// Replaying the log rebuilds every computed value, which is what lets the file
// carry one expression instead of a column of results.
test("replay rebuilds what was computed", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));
  s.set(0, 2, "10.00");

  const replayed = sales();
  replayed.replay(s.edits());

  for (let row = 0; row < s.rows(); row++) {
    expect(replayed.display(row, 3), `row ${row}`).toBe(s.display(row, 3));
  }
});

// Undo is truncate-and-replay, so a binding has to come back out the way any
// other operation does. This is the reason a binding is a log line and not a
// line of sheet state, which Ctrl+Z could never have reached.
test("a binding can be undone", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));

  const undone = sales();
  undone.replay(s.edits().slice(0, 0));

  expect(undone.display(0, 3)).toBe("");
  expect(undone.binding(3), "still bound after replaying the binding away").toBeUndefined();
});

// The badge over a bound column has to describe what a person can see in it.
// Reading the stored values would call a column of numbers text, because a
// derived column stores nothing at all.
test("a bound column is named for what it computes", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));
  expect(s.columns[3]!.kind).toBe("num");
});

// Binding never removed a column's values; it stopped them being what display
// handed out. Taking the formula off has to give them back, and the badge over
// the column with them.
test("removing a formula gives a column its own values back", () => {
  const s = sales();
  s.bind(0, parse("price * 2"));
  expect(s.display(0, 0)).toBe("80");

  s.unbind(0);

  expect(["West", "East", "North"].map((_, row) => s.display(row, 0))).toEqual([
    "West",
    "East",
    "North",
  ]);
  expect(s.binding(0)).toBeUndefined();
  expect(s.columns[0]!.kind, "re-inferred from the values that came back").toBe("text");
});

// A column that read a bound one was reading what that column computed. Once
// nothing computes it, they are reading what it stores, and a recalculation
// that stopped at the column being unbound would leave them showing arithmetic
// on values nobody can see any more.
test("removing a formula recalculates what read it", () => {
  const s = sales();
  s.bind(2, parse("price * 2"));
  s.bind(3, parse("cost + 1"));
  expect(s.display(0, 3)).toBe("81");

  s.unbind(2);

  expect(s.display(0, 3)).toBe("32.2");
});

// Undo is truncate-and-replay, which is why removing a formula is an operation
// rather than something done to the sheet on the side.
test("removing a formula can be undone", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));
  s.unbind(3);
  expect(s.editCount(), "the removal should be a line of its own").toBe(2);

  const undone = sales();
  undone.replay(s.edits().slice(0, 1));

  expect(undone.display(0, 3)).toBe("8.8");
});

// A log line that removes nothing is a log that does not belong to these bytes.
test("removing a formula from a column that has none is refused", () => {
  const s = sales();

  let thrown: Error | undefined;
  try {
    s.unbind(3);
  } catch (err) {
    thrown = err as Error;
  }

  expect(thrown).toBeDefined();
  expect(thrown!.message, "the column should be named").toContain("margin");
  expect(s.editCount(), "a refused removal wrote a line").toBe(0);
});

// The cache entry has to go back to empty and not to a filled array. A column
// nothing computes but whose cache is filled is a column holding notation, and
// binding refuses to write over one of those -- so a stale cache would make a
// removal a one-way door.
test("a column can be bound again after its formula is removed", () => {
  const s = sales();
  s.bind(3, parse("price - cost"));
  s.unbind(3);

  s.bind(3, parse("price + cost"));
  expect(s.display(0, 3)).toBe("71.2");
});

// A .uno is raw bytes plus the log, so a workspace whose formula was removed
// has to rebuild that way on open rather than only in the session it happened in.
test("replay rebuilds a column whose formula was removed", () => {
  const s = sales();
  s.bind(0, parse("price * 2"));
  s.unbind(0);

  const replayed = sales();
  replayed.replay(s.edits());

  expect(replayed.display(0, 0)).toBe("West");
  expect(replayed.binding(0)).toBeUndefined();
});
