import { describe, expect, test } from "vite-plus/test";

import {
  DivideByZeroError,
  Formula,
  NotNumberError,
  type Row,
  UnknownColumnError,
  evaluate,
  evaluateColumn,
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

  // Binary floats, so compare within a tolerance no cell displays.
  const DIGITS = 9;

  for (const [src, want] of cases) {
    test(src, () => {
      expect(evaluate(parse(src), sample)).toBeCloseTo(want, DIGITS);
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

// A bound column is computed a column at a time, and every row of it has to come
// out as the one-row preview says it will: its number, or the failure that row
// would have thrown first.
describe("evaluateColumn computes every row as one row would", () => {
  const cols: Record<string, string[]> = {
    price: ["40.00", "10", "n/a", "8"],
    cost: ["31.20", "x", "5", "8"],
    zero: ["0", "0", "0", "2"],
  };
  const src = { column: (name: string) => cols[name] };
  const at = (i: number) =>
    row(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v[i]!])));

  const exprs = [
    "price - cost",
    "(price - cost) / price",
    "cost / zero", // row 1 fails on cost before it reaches the divisor
    "price / (zero - zero)",
    "-price * 2",
    "price + postage",
  ];

  for (const src_ of exprs) {
    test(src_, () => {
      const { values, errors } = evaluateColumn(parse(src_), 4, src);
      for (let i = 0; i < 4; i++) {
        let want: number | Error;
        try {
          want = evaluate(parse(src_), at(i));
        } catch (err) {
          want = err as Error;
        }
        if (want instanceof Error) {
          expect(errors[i], `row ${i}`).toBeInstanceOf(want.constructor);
          expect(errors[i]!.message, `row ${i}`).toBe(want.message);
        } else {
          expect(errors[i], `row ${i}`).toBeUndefined();
          expect(values[i], `row ${i}`).toBe(want);
        }
      }
    });
  }

  test("a row keeps the first failure it meets", () => {
    const { errors } = evaluateColumn(parse("cost / zero"), 4, src);
    expect(errors[1]).toBeInstanceOf(NotNumberError);
    expect(errors[0]).toBeInstanceOf(DivideByZeroError);
    expect(errors[3]).toBeUndefined();
  });
});
