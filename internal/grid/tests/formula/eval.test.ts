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

// A Row backed by a plain object, standing in for a sheet.
function row(cells: Record<string, string>): Row {
  return { value: (col) => cells[col] };
}

// evaluate follows precedence and brackets, and reads decorated numbers.
describe("evaluate computes what was written", () => {
  const sample = row({
    units: "120",
    price: "40.00",
    cost: "31.20",
    gross: "1,204.50", // decorated, still a number
    blank: "",
    label: "West",
  });

  const cases: Array<[string, number]> = [
    ["1 + 2", 3],
    ["units * price", 4800],
    ["price - cost", 8.8],
    ["(price - cost) / price", 0.22],
    ["price - cost / price", 40 - 31.2 / 40], // division binds tighter
    ["(1 + 2) * 3", 9],
    ["1 + 2 * 3", 7],
    ["10 - 3 - 2", 5], // left-associative
    ["-price", -40],
    ["-(price - cost)", -8.8],
    ["gross / 2", 602.25],
    ["0 - -1", 1],
  ];

  // Compare within a floating point tolerance.
  const DIGITS = 9;

  for (const [src, want] of cases) {
    test(src, () => {
      expect(evaluate(parse(src), sample)).toBeCloseTo(want, DIGITS);
    });
  }
});

// evaluate throws a typed error whose message names the failing column or
// literal.
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

// Evaluating an empty Formula throws.
test("evaluating the empty formula fails rather than crashing", () => {
  expect(() => evaluate(new Formula(), row({}))).toThrow();
});

// evaluateColumn gives each row the same value or error that evaluate gives
// for that row alone.
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
    "cost / zero", // row 1 fails on cost before the divisor
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

  // Rows that divide by zero share one DivideByZeroError instance. Its
  // message names the divisor column, so it is the same for every row.
  test("a column that divides by zero fails once, not once per row", () => {
    const { errors } = evaluateColumn(parse("price / zero"), 4, src);
    expect(errors[0]).toBeInstanceOf(DivideByZeroError);
    expect(errors[1]).toBe(errors[0]);
    expect(errors[2]).toBeInstanceOf(NotNumberError); // price is "n/a" in row 2
    expect(errors[3]).toBeUndefined();
  });
});
