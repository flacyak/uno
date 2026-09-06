import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { parse as parseFormulaExpr } from "../../src/formula/index.ts";
import { formatFormula, parseFormula } from "../../src/library/index.ts";
import { supported } from "../../src/notation/index.ts";

/** The .unof files the Go build ships as fixtures, read by the TypeScript one.
 * A formula is a file meant to travel, so a file written by either build has to
 * open in the other. */
function fixture(id: string): string {
  const path = fileURLToPath(new URL(`../testdata/${id}.unof`, import.meta.url));
  return readFileSync(path, "utf8");
}

describe("the .unof files the Go build wrote", () => {
  test("a column formula", () => {
    const f = parseFormula("unit-margin.unof", fixture("unit-margin"));
    expect(f.kind).toBe("column");
    expect(f.id).toBe("unit-margin");
    // The expression is the one thing that has to survive: it is what the
    // column computes from.
    expect(() => parseFormulaExpr(f.expr)).not.toThrow();
    expect(parseFormulaExpr(f.expr).refs()).toEqual(f.refs ?? []);
  });

  test("a notation formula", () => {
    const f = parseFormula("variance.unof", fixture("variance"));
    expect(f.kind).toBe("notation");
    expect(supported(f.expr), "the subset should still draw it").toBeUndefined();
  });

  test("every fixture round-trips", () => {
    for (const id of ["unit-margin", "variance", "std-deviation"]) {
      const f = parseFormula(`${id}.unof`, fixture(id));
      const back = parseFormula(`${id}.unof`, formatFormula(f).text);
      expect(back.id, id).toBe(f.id);
      expect(back.name, id).toBe(f.name);
      expect(back.kind, id).toBe(f.kind);
      expect(back.expr, id).toBe(f.expr);
      expect(back.refs, id).toEqual(f.refs);
    }
  });
});
