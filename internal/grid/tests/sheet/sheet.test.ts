import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { read } from "../../src/ingest/index.ts";
import { Sheet } from "../../src/sheet/index.ts";
import { parse } from "../../src/formula/index.ts";

test("raw tolerates ragged and out-of-range", () => {
  // The second row is short: a real export does this, and the grid must not
  // have to bounds-check while scrolling.
  const s = new Sheet("t.csv", ["a", "b", "c"], [["1", "2", "3"], ["4"]]);

  const cases: Array<[string, number, number, string]> = [
    ["present", 0, 1, "2"],
    ["short row", 1, 2, ""],
    ["row past end", 9, 0, ""],
    ["negative row", -1, 0, ""],
    ["col past end", 0, 9, ""],
    ["negative col", 0, -1, ""],
  ];

  for (const [name, row, col, want] of cases) {
    expect(s.raw(row, col), name).toBe(want);
  }
});

// What this pins still holds everywhere nothing has been computed: an unbound
// column shows what it stores, and out-of-range stays empty on both paths.
test("display is raw where nothing fills it", () => {
  const s = new Sheet("t.csv", ["a", "b", "c"], [["1", "2", "3"], ["4"]]);

  for (let row = -1; row <= s.rows(); row++) {
    for (let col = -1; col <= s.cols(); col++) {
      expect(s.display(row, col), `(${row},${col})`).toBe(s.raw(row, col));
    }
  }
});

// And the other half of it: once a column is bound the two part company, which
// is the whole point of having split them. raw keeps saying what the cell
// stores, which is nothing, because a derived column holds no values of its own.
test("display leaves raw behind once a column is bound", () => {
  const s = new Sheet(
    "t.csv",
    ["price", "cost", "margin"],
    [
      ["40", "31.20", ""],
      ["40", "30", ""],
    ],
  );

  s.bind(2, parse("price - cost"));

  expect(s.display(0, 2)).toBe("8.8");
  expect(s.raw(0, 2), "the cell should store nothing").toBe("");
});

test("rows and cols count data, not the header", () => {
  const s = new Sheet(
    "t.csv",
    ["a", "b"],
    [
      ["1", "2"],
      ["3", "4"],
    ],
  );
  expect(s.rows()).toBe(2);
  expect(s.cols()).toBe(2);
});

// The four columns the design doc draws, including the flagged one the whole
// feature exists for.
describe("inferKind", () => {
  const s = new Sheet(
    "t.csv",
    ["date", "region", "units", "revenue", "blank"],
    [
      ["2026-07-01", "West", "1,204", "48160.00", ""],
      ["2026-07-01", "East", "987", "39480.00", ""],
      ["2026-07-02", "North", "1,455", "58200.00", ""],
    ],
  );

  const cases: Array<[number, string, boolean]> = [
    [0, "date", false],
    [1, "text", false],
    [2, "text", true], // numbers wearing thousands separators
    [3, "num", false],
    [4, "text", false], // no evidence at all
  ];

  for (const [col, kind, flagged] of cases) {
    test(s.columns[col]!.header, () => {
      expect(s.columns[col]!.kind).toBe(kind);
      expect(s.columns[col]!.flagged).toBe(flagged);
    });
  }
});

// The costume a number wears is not always a comma.
describe("inferKind flags the other decorations", () => {
  const s = new Sheet(
    "t.csv",
    ["amount", "rate", "swiss", "spaced", "mixed"],
    [
      ["$1,204", "12.5%", "1'204", "1 204", "$1,204"],
      ["$87", "3%", "9'870", "9 870", "N/A"],
      ["$3,010", "88.1%", "2'000", "2 000", "$3,010"],
    ],
  );

  const cases: Array<[number, string, boolean]> = [
    [0, "text", true], // currency and separators
    [1, "text", true], // percent
    [2, "text", true], // apostrophe separator
    [3, "text", true], // space separator
    [4, "text", false], // a genuine non-number keeps it mixed
  ];

  for (const [col, kind, flagged] of cases) {
    test(s.columns[col]!.header, () => {
      expect(s.columns[col]!.kind).toBe(kind);
      expect(s.columns[col]!.flagged).toBe(flagged);
    });
  }
});

// A column of numbers with genuinely non-numeric values in it is mixed, not
// misformatted, so it must not raise the flag the recogniser acts on.
test("inferKind does not flag genuinely mixed columns", () => {
  const s = new Sheet("t.csv", ["units"], [["12"], ["34"], ["56"], ["N/A"]]);
  expect(s.columns[0]!.kind).toBe("text");
  expect(s.columns[0]!.flagged).toBe(false);
});

// `new Date` would accept every one of the not-dates; the written layouts do
// not, and a text column wearing a date badge is a wrong answer that looks
// deliberate.
describe("isDate is the written layouts and not whatever Date can parse", () => {
  const dates = [
    "2026-07-01",
    "2026-07-01T12:00:00Z",
    "2026-07-01T12:00:00+01:00",
    "2024/11/16",
    "2024.11.16",
    "2024-1-6",
    "20-11-2024",
    "07/01/2026",
    "11/20/2024",
    "1.6.2024",
    "Nov. 6, 1970",
    "Nov 6 1970",
    "November 6, 1970",
    "sept 6 1970",
    "6 Nov 1970",
    "06-Nov-1970",
    "July 1 2026",
  ];
  const notDates = [
    "2026",
    "2026-07",
    "Nov 1970",
    "Novem 6, 1970",
    "Item 6, 1970",
    "Feb 30, 1970",
    "6 Nov-1970",
    "2026-13-01",
    "2026-07-32",
    "2026/07-01",
    "13/13/2026",
    "31-02-2024",
    "07/01/26",
  ];

  for (const v of dates) {
    test(`${v} is a date`, () => {
      const s = new Sheet("t.csv", ["d"], [[v]]);
      expect(s.columns[0]!.kind).toBe("date");
    });
  }

  for (const v of notDates) {
    test(`${v} is not`, () => {
      const s = new Sheet("t.csv", ["d"], [[v]]);
      expect(s.columns[0]!.kind).not.toBe("date");
    });
  }
});

// An ad export that wrote its dates three ways down one column: 2024-11-16,
// 2024/11/16 and 20-11-2024. Every one is a date, so the column is.
test("a column of mixed date layouts is a date column", () => {
  const path = fileURLToPath(new URL("../testdata/google-ads-sales.csv", import.meta.url));
  const s = read("google-ads-sales.csv", readFileSync(path));
  const col = s.columns.findIndex((c) => c.header === "Ad_Date");
  expect(col).toBeGreaterThanOrEqual(0);
  expect(s.columns[col]!.kind).toBe("date");
});
