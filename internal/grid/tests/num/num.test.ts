import { describe, expect, test } from "vite-plus/test";

import { isNumber, parse, undress } from "../../src/num/index.ts";

// The list is the point: a plain parse accepts everything in the second group,
// and a column of them is not numeric data.
describe("isNumber rejects what a spreadsheet does not mean", () => {
  for (const v of ["12", "-3.5", "+7", "1e3", "0.0"]) {
    test(`accepts ${JSON.stringify(v)}`, () => {
      expect(isNumber(v)).toBe(true);
    });
  }

  for (const v of ["inf", "NaN", "0x1p-2", "1,204", "", "12 "]) {
    test(`refuses ${JSON.stringify(v)}`, () => {
      expect(isNumber(v)).toBe(false);
    });
  }
});

// Undressing is what separates a number in a costume from text. It has to take
// the costume off and leave everything else on: the full stop it does not strip
// is what keeps 3.5 a number, and the letters it does not strip are what keep
// "N/A" out of a numeric column.
describe("undress takes off the costume and nothing else", () => {
  const cases: Array<[string, string]> = [
    ["1,204", "1204"],
    ["$1,204.50", "1204.50"],
    ["£40.00", "40.00"],
    ["€1 204", "1204"],
    ["12%", "12"],
    ["1'204", "1204"],
    [" 987 ", "987"],
    ["3.5", "3.5"],
    ["N/A", "N/A"],
    ["", ""],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${JSON.stringify(want)}`, () => {
      expect(undress(input)).toBe(want);
    });
  }
});

// parse is the coercion an evaluator runs per cell, so what it accepts decides
// which columns arithmetic can be bound to. It undresses first: a column of
// 1,204 is one people expect to multiply, and refusing it for wearing a comma
// would make the numeric badge's promise a lie one screen later.
describe("parse reads the number a person sees", () => {
  const cases: Array<[string, number | undefined]> = [
    ["12", 12],
    ["-3.5", -3.5],
    ["1,204", 1204],
    ["$1,204.50", 1204.5],
    ["£40.00", 40],
    [" 987 ", 987],

    // A percent sign is decoration, so 12% reads as the 12 that was written.
    // Dividing by a hundred here would invent a value nobody typed and no cell
    // displays.
    ["12%", 12],

    ["", undefined],
    ["N/A", undefined],
    ["inf", undefined],
    ["NaN", undefined],
    ["0x1p-2", undefined],
    ["1.2.3", undefined],
    ["12 ea", undefined],
  ];

  for (const [input, want] of cases) {
    test(`${JSON.stringify(input)} => ${want}`, () => {
      expect(parse(input)).toBe(want);
    });
  }
});
