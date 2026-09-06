import { describe, expect, test } from "vite-plus/test";

import {
  DivideByZeroError,
  Formula,
  NotNumberError,
  type Row,
  UnknownColumnError,
  evaluate,
  parse,
} from "../../src/formula/index.ts";

// row is the whole of what an evaluator needs from a sheet, which is the point
// of the Row interface: this test holds no sheet, and neither does the module.
function row(cells: Record<string, string>): Row {
  return { value: (col) => cells[col] };
}

// The preview in the editor evaluates row one as a person types, so the
// arithmetic has to be the arithmetic they wrote: precedence, their brackets,
// and cells read through the same coercion the numeric badge promised.
describe("evaluate computes what was written", () => {
  const sample = row({
    units: "120",
    price: "40.00",
    cost: "31.20",
    gross: "1,204.50", // decorated, and still a number
    blank: "",
    label: "West",
  });

  const cases: Array<[string, number]> = [
    ["1 + 2", 3],
    ["units * price", 4800],
    ["price - cost", 8.8],
    ["(price - cost) / price", 0.22],
    ["price - cost / price", 40 - 31.2 / 40], // precedence, not left to right
    ["(1 + 2) * 3", 9],
    ["1 + 2 * 3", 7],
    ["10 - 3 - 2", 5], // left-associative
    ["-price", -40],
    ["-(price - cost)", -8.8],
    ["gross / 2", 602.25],
    ["0 - -1", 1],
  ];

  for (const [src, want] of cases) {
    test(src, () => {
      // Binary floats, so compare within a tolerance no cell displays.
      expect(evaluate(parse(src), sample)).toBeCloseTo(want, 9);
    });
  }
});

// A per-cell failure has to be reportable, and it has to name the column. The
// class is what the caller branches on; the message is what it shows. This is
// deliberately unlike program.apply, which returns the original value and says
// nothing, because a program meets rows it was never induced from and a formula
// meets a column a person chose.
describe("evaluate reports which column failed and why", () => {
  const sample = row({
    price: "40.00",
    cost: "n/a",
    blank: "",
    zero: "0",
  });

  const cases: Array<[string, new (m: string) => Error, string]> = [
    ["price * quantity", UnknownColumnError, "quantity"],
    ["price - cost", NotNumberError, "cost"],
    ["price - blank", NotNumberError, "blank"],
    ["price / zero", DivideByZeroError, "zero"],
    ["price / (zero * 2)", DivideByZeroError, "zero"],
    ["price / 0", DivideByZeroError, "0"],
  ];

  for (const [src, kind, name] of cases) {
    test(src, () => {
      let thrown: unknown;
      try {
        evaluate(parse(src), sample);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `evaluate(${src}) did not fail`).toBeInstanceOf(kind);
      expect((thrown as Error).message).toContain(name);
    });
  }
});

// A binding read out of a state.json some other build wrote can be empty. It
// has to fail on the path that evaluates it rather than take the window down.
test("evaluating the empty formula fails rather than crashing", () => {
  expect(() => evaluate(new Formula(), row({}))).toThrow();
});
