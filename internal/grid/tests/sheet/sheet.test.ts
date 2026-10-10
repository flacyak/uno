import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { read } from "../../src/ingest/index.ts";
import { Sheet } from "../../src/sheet/index.ts";
import { parse } from "../../src/formula/index.ts";

test("raw tolerates ragged and out-of-range", () => {
  // The second row is short. raw returns "" for any missing or out-of-range cell.
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

// Before any column is bound, display equals raw for every cell, including
// out-of-range ones.
test("display is raw where nothing fills it", () => {
  const s = new Sheet("t.csv", ["a", "b", "c"], [["1", "2", "3"], ["4"]]);

  for (let row = -1; row <= s.rows(); row++) {
    for (let col = -1; col <= s.cols(); col++) {
      expect(s.display(row, col), `(${row},${col})`).toBe(s.raw(row, col));
    }
  }
});

// Once a column is bound, display shows the computed value and raw still
// returns the stored value, which is empty.
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

// Column kinds for date, text, flagged text, num, and empty columns.
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
    [2, "text", true], // numbers with thousands separators
    [3, "num", false],
    [4, "text", false], // every cell empty
  ];

  for (const [col, kind, flagged] of cases) {
    test(s.columns[col]!.header, () => {
      expect(s.columns[col]!.kind).toBe(kind);
      expect(s.columns[col]!.flagged).toBe(flagged);
    });
  }
});

// Other number decorations that set the flag.
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
    [4, "text", false], // N/A is a word, so the column is mixed
  ];

  for (const [col, kind, flagged] of cases) {
    test(s.columns[col]!.header, () => {
      expect(s.columns[col]!.kind).toBe(kind);
      expect(s.columns[col]!.flagged).toBe(flagged);
    });
  }
});

// A trailing minus sign or parentheses count as a negative number.
test("inferKind reads accounting negatives as numbers", () => {
  const cases: Array<[string, string[], string, boolean]> = [
    ["sap", ["1234.00-", "87.50", "0.00", "12.00-"], "num", false],
    ["oracle", ["(1234.00)", "87.50", "(0.50)"], "num", false],
    ["sap with separators", ["1,234.00-", "87.50"], "text", true],
    ["oracle with currency", ["$(1,234.00)", "$87.50"], "text", true],
  ];

  for (const [name, values, kind, flagged] of cases) {
    const s = new Sheet(
      "t.csv",
      ["amount"],
      values.map((v) => [v]),
    );
    expect(s.columns[0]!.kind, name).toBe(kind);
    expect(s.columns[0]!.flagged, name).toBe(flagged);
  }
});

// A column mixing numbers with a word like N/A is text and stays unflagged.
test("inferKind does not flag genuinely mixed columns", () => {
  const s = new Sheet("t.csv", ["units"], [["12"], ["34"], ["56"], ["N/A"]]);
  expect(s.columns[0]!.kind).toBe("text");
  expect(s.columns[0]!.flagged).toBe(false);
});

// Date detection accepts only the listed layouts.
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
    "2026-07-01T24:00:00Z",
    "2026-07-01T23:60:00Z",
    "2026-07-01T23:59:60Z",
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

// The Ad_Date column mixes the layouts 2024-11-16, 2024/11/16 and 20-11-2024.
// Every value is a date, so the column kind is date.
test("a column of mixed date layouts is a date column", () => {
  const path = fileURLToPath(new URL("../testdata/google-ads-sales.csv", import.meta.url));
  const s = read("google-ads-sales.csv", readFileSync(path));
  const col = s.columns.findIndex((c) => c.header === "Ad_Date");
  expect(col).toBeGreaterThanOrEqual(0);
  expect(s.columns[col]!.kind).toBe("date");
});
