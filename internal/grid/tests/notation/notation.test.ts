import { describe, expect, test } from "vite-plus/test";

import {
  NO_GLYPH,
  SUBSCRIPTS,
  SUPERSCRIPTS,
  SYMBOLS,
  render,
  supported,
} from "../../src/notation/index.ts";

// Each case checks render and supported together on the same source.
describe("the subset draws the notation a person types", () => {
  const cases: Array<[string, string]> = [
    ["x^2", "x²"],
    ["x_1", "x₁"],
    ["e^{x}", "eˣ"],
    ["x^{10}", "x¹⁰"], // a bare ^ takes one character; a group takes several
    ["x^{n+1}", "xⁿ⁺¹"], // the plus is raised too
    ["T_{max}", "Tₘₐₓ"],
    ["\\alpha + \\beta", "α + β"],
    ["\\pm \\times \\div", "± × ÷"],
    ["\\Sigma \\mu \\Omega", "Σ μ Ω"],
    ["\\frac{a}{b}", "a⁄b"],
    ["\\frac{x^2}{y_1}", "x²⁄y₁"], // groups inside a fraction are rendered
    ["\\sigma = \\frac{1}{n}", "σ = 1⁄n"],
    ["(a+b)^{2}", "(a+b)²"],
    ["\\mu_i", "μᵢ"],
    ["revenue", "revenue"], // plain text is unchanged
    ["", ""],
  ];

  for (const [src, want] of cases) {
    test(JSON.stringify(src), () => {
      expect(render(src)).toBe(want);
      expect(supported(src)).toBeUndefined();
    });
  }
});

// supported returns an error naming the first symbol outside the subset.
describe("supported names the first symbol it cannot draw", () => {
  const cases: Array<[string, string]> = [
    ["x_q", '"q"'], // subscript q is outside the glyph table
    ["x_b", '"b"'],
    ["x_z", '"z"'],
    ["\\sum_{i=1}^{n} x_i", "\\sum"], // in NO_GLYPH
    ["\\sqrt{x^2+y^2}", "\\sqrt"],
    ["a \\ne b", "\\ne"],
    ["\\arctan", "\\arctan"], // outside every table
    ["x^", '"^"'],
    ["x_", '"_"'],
    ["\\frac{a}", "\\frac"],
    ["a \\ b", "\\ names no symbol"],
    ["x^{\\alpha}", "\\alpha"], // superscript Greek is refused
    ["\\frac{x_q}{b}", '"q"'], // groups are checked too

    // The first unsupported symbol is named.
    ["x_q + \\arctan", '"q"'],
    ["\\arctan + x_q", "\\arctan"],
  ];

  for (const [src, names] of cases) {
    test(`${JSON.stringify(src)} names ${names}`, () => {
      const err = supported(src);
      expect(err, `supported accepted ${JSON.stringify(src)}`).toBeDefined();
      expect(err!.message).toContain(names);
    });
  }
});

// render always returns a string. Anything outside its glyph table is copied
// through as typed.
describe("render keeps what it cannot draw", () => {
  const cases: Array<[string, string]> = [
    ["x_q", "x_q"],
    ["\\arctan{x}", "\\arctan{x}"],
    ["\\sqrt{x^2}", "\\sqrt{x²}"], // the group inside is still rendered
    ["\\sum_{i=1}^{n}", "\\sumᵢ₌₁ⁿ"], // the scripts are still rendered
    ["x^{\\alpha} y_2", "x^{\\alpha} y₂"], // an unsupported script is kept whole
  ];

  for (const [src, want] of cases) {
    test(JSON.stringify(src), () => {
      expect(render(src)).toBe(want);
    });
  }
});

// Every key in SYMBOLS, SUPERSCRIPTS and SUBSCRIPTS renders and is supported.
describe("every table entry is reachable from a source", () => {
  test("symbols", () => {
    for (const [name, want] of SYMBOLS) {
      const src = "\\" + name;
      expect(render(src), src).toBe(want);
      expect(supported(src), src).toBeUndefined();
    }
  });

  for (const [mark, table] of [
    ["^", SUPERSCRIPTS],
    ["_", SUBSCRIPTS],
  ] as Array<[string, Map<string, string>]>) {
    test(`${mark} scripts`, () => {
      for (const [k, want] of table) {
        const src = "x" + mark + k;
        expect(render(src), src).toBe("x" + want);
        expect(supported(src), src).toBeUndefined();
      }
    });
  }
});

// NO_GLYPH and SYMBOLS are disjoint.
test("no name is both drawable and refused", () => {
  for (const name of NO_GLYPH.keys()) {
    expect(SYMBOLS.has(name), `\\${name} is refused and also drawn`).toBe(false);
  }
});
