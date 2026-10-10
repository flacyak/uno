import { describe, expect, test } from "vite-plus/test";

import { isNumber, parse, undress } from "../../src/num/index.ts";

// isNumber accepts plain and accounting-style numbers and refuses the rest,
// including values Number() would accept.
describe("isNumber rejects what a spreadsheet does not mean", () => {
  for (const v of ["12", "-3.5", "+7", "1e3", "0.0", "1234.00-", "(1234.00)"]) {
    test(`accepts ${JSON.stringify(v)}`, () => {
      expect(isNumber(v)).toBe(true);
    });
  }

  for (const v of [
    "inf",
    "NaN",
    "0x1p-2",
    "1,204",
    "",
    "12 ",
    "-",
    "()",
    "(-5)",
    "-5-",
    "(5",
    "5)",
    "(5)-",
    "1e400",
  ]) {
    test(`refuses ${JSON.stringify(v)}`, () => {
      expect(isNumber(v)).toBe(false);
    });
  }
});

// undress strips currency signs, thousands separators, percent signs and
// surrounding space. It keeps the decimal point and letters.
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

// parse undresses the value first, then reads it as a number.
describe("parse reads the number a person sees", () => {
  const cases: Array<[string, number | undefined]> = [
    ["12", 12],
    ["-3.5", -3.5],
    ["1,204", 1204],
    ["$1,204.50", 1204.5],
    ["£40.00", 40],
    [" 987 ", 987],

    // Whitespace at either edge is trimmed the same way column kind inference
    // trims it, including tab, CR and no-break space.
    ["12\t", 12],
    ["12\r", 12],
    ["\u00a012", 12],
    ["\t1,204\t", 1204],

    // A percent sign is stripped and the number keeps its written scale.
    ["12%", 12],

    // Accounting negatives: trailing minus sign or parentheses.
    ["1234.00-", -1234],
    ["(1234.00)", -1234],
    ["1,234.00-", -1234],
    ["$(1,234.00)", -1234],

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
