import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { parse as parseFormulaExpr } from "../../src/formula/index.ts";
import { formatFormula, parseFormula } from "../../src/library/index.ts";
import { supported } from "../../src/notation/index.ts";

/** Reads a .unof fixture written by the Go build. */
function fixture(id: string): string {
  const path = fileURLToPath(new URL(`../testdata/${id}.unof`, import.meta.url));
  return readFileSync(path, "utf8");
}

describe("the .unof files the Go build wrote", () => {
  test("a column formula", () => {
    const f = parseFormula("unit-margin.unof", fixture("unit-margin"));
    expect(f.kind).toBe("column");
    expect(f.id).toBe("unit-margin");
    // The expression parses and its refs match the file's refs.
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
