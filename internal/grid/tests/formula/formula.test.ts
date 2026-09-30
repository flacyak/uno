import { describe, expect, test } from "vite-plus/test";

import { Formula, parse } from "../../src/formula/index.ts";

// parse then toString gives back the same text.
describe("the text form round-trips", () => {
  const corpus = [
    "units",
    "1",
    "40.00",
    "units * price",
    "price - cost",
    "total / 2",
    "(price - cost) / price",
    "a + b * c",
    "(a + b) * c",
    "a - b - c",
    "a - (b - c)",
    "1 + 2 * 3 - 4 / 5",
    "-price",
    "-(a + b)",
    "0 - -1",
    "gross * (1 - tax_rate)",
    "_private + n2",
    "région * 2",
  ];

  for (const src of corpus) {
    test(src, () => {
      const f = parse(src);
      expect(f.toString()).toBe(src);
      expect(() => parse(f.toString())).not.toThrow();
    });
  }
});

// toString normalises spacing around operators and keeps every bracket as
// written.
describe("spacing is normalised and brackets are kept", () => {
  const cases: Array<[string, string]> = [
    ["units*price", "units * price"],
    ["  units   *price ", "units * price"],
    ["(price-cost)/price", "(price - cost) / price"],
    ["(a) + b", "(a) + b"], // redundant brackets are kept
    ["((a))", "((a))"], // nested redundant brackets are kept
    ["a + (b * c)", "a + (b * c)"],
  ];

  for (const [src, want] of cases) {
    test(src, () => {
      const f = parse(src);
      expect(f.toString()).toBe(want);
      expect(() => parse(f.toString())).not.toThrow();
    });
  }
});

// refs returns every column name in the expression, sorted and deduplicated.
describe("refs names every column read once", () => {
  const cases: Array<[string, string[]]> = [
    ["units * price", ["price", "units"]],
    ["(price - cost) / price", ["cost", "price"]],
    ["-margin", ["margin"]],
    ["a * (b + c) - a", ["a", "b", "c"]],
    ["1 + 2 * 3", []],
    ["gross * (1 - tax_rate)", ["gross", "tax_rate"]],
  ];

  for (const [src, want] of cases) {
    test(src, () => {
      expect(parse(src).refs()).toEqual(want);
    });
  }
});

// parse throws on malformed input.
describe("parse refuses what it cannot run", () => {
  const corpus = [
    "",
    "   ",
    "1 +",
    "+ 1",
    "* 2",
    "a b",
    "2x",
    "(1 + 2",
    "1 + 2)",
    "()",
    "a ** b",
    "a / / b",
    "1..2",
    "1.",
    ".5",
    "1e3", // exponents are refused
    "1,204", // thousands separators are refused
    "a $ b",
    '"price"', // quotes are refused
    "Q3 (net)", // a header needs identifier syntax to be referenced
    "price * ",
  ];

  for (const src of corpus) {
    test(JSON.stringify(src), () => {
      expect(() => parse(src)).toThrow();
    });
  }
});

// An empty Formula has empty text and an empty refs list.
test("the empty formula is empty rather than a crash", () => {
  const f = new Formula();
  expect(f.toString()).toBe("");
  expect(f.refs()).toEqual([]);
});
