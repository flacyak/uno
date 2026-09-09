import { describe, expect, test } from "vite-plus/test";

import { Formula, parse } from "../../src/formula/index.ts";

// The text form is what a .uno and a .unof both carry, so an expression that
// has been through a file has to be the expression that went in.
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

// toString is a normal form rather than a transcription: spacing is the
// parser's to decide, but bracketing is the person's. Their brackets are how
// they show their working, and one this package removed would be an edit to an
// expression it was only asked to store.
describe("spacing is normalised and brackets are kept", () => {
  const cases: Array<[string, string]> = [
    ["units*price", "units * price"],
    ["  units   *price ", "units * price"],
    ["(price-cost)/price", "(price - cost) / price"],
    ["(a) + b", "(a) + b"], // redundant, and still theirs
    ["((a))", "((a))"], // twice redundant, and still theirs
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

// refs is what the dependency graph is built out of, so a name it misses is an
// edge the graph does not have and a cycle it would accept. Sorted and
// deduplicated because the answer reaches a person, in a .unof's refs and in
// the path a refused binding names.
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

// A stored expression this build cannot read must fail before a single cell
// moves, so everything that is not an expression has to be refused here rather
// than surviving to the row it breaks on.
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
    "1e3", // an exponent is not a thing a spreadsheet holds
    "1,204", // decoration belongs to the cell, not to the expression
    "a $ b",
    '"price"', // there is no quoting syntax, on purpose
    "Q3 (net)", // a header that is not an identifier cannot be referenced
    "price * ",
  ];

  for (const src of corpus) {
    test(JSON.stringify(src), () => {
      expect(() => parse(src)).toThrow();
    });
  }
});

// A binding can arrive out of a state.json written by another build. A missing
// expression has to be a value that fails, not a crash on the path that reads
// it.
test("the empty formula is empty rather than a crash", () => {
  const f = new Formula();
  expect(f.toString()).toBe("");
  expect(f.refs()).toEqual([]);
});
