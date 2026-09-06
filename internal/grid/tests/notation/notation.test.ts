import { describe, expect, test } from "vite-plus/test";

import {
  NO_GLYPH,
  SUBSCRIPTS,
  SUPERSCRIPTS,
  SYMBOLS,
  render,
  supported,
} from "../../src/notation/index.ts";

// The subset, expression by expression.
//
// Rendering and acceptance are checked together on purpose. Two tables would
// let a source drift into being drawn one way and refused for another.
describe("the subset draws the notation a person types", () => {
  const cases: Array<[string, string]> = [
    ["x^2", "x²"],
    ["x_1", "x₁"],
    ["e^{x}", "eˣ"],
    ["x^{10}", "x¹⁰"], // a group, because a bare ^ takes one character
    ["x^{n+1}", "xⁿ⁺¹"], // the plus is raised too, or the exponent is two sizes
    ["T_{max}", "Tₘₐₓ"],
    ["\\alpha + \\beta", "α + β"],
    ["\\pm \\times \\div", "± × ÷"],
    ["\\Sigma \\mu \\Omega", "Σ μ Ω"],
    ["\\frac{a}{b}", "a⁄b"],
    ["\\frac{x^2}{y_1}", "x²⁄y₁"], // a group is rendered, not copied
    ["\\sigma = \\frac{1}{n}", "σ = 1⁄n"],
    ["(a+b)^{2}", "(a+b)²"],
    ["\\mu_i", "μᵢ"],
    ["revenue", "revenue"], // a cell with no notation in it is left alone
    ["", ""],
  ];

  for (const [src, want] of cases) {
    test(JSON.stringify(src), () => {
      expect(render(src)).toBe(want);
      expect(supported(src)).toBeUndefined();
    });
  }
});

// The editor's whole promise: a symbol outside the subset is refused by name at
// authoring time, never discovered later as an empty box. An error that failed
// to name the symbol would leave a person hunting through their own expression
// for whichever part of it uno meant.
describe("supported names the first symbol it cannot draw", () => {
  const cases: Array<[string, string]> = [
    ["x_q", '"q"'], // 14 of the 26 subscript letters do not exist
    ["x_b", '"b"'],
    ["x_z", '"z"'],
    ["\\sum_{i=1}^{n} x_i", "\\sum"], // no glyph in the font the desktop bundles
    ["\\sqrt{x^2+y^2}", "\\sqrt"],
    ["a \\ne b", "\\ne"],
    ["\\arctan", "\\arctan"], // never in the subset at all
    ["x^", '"^"'],
    ["x_", '"_"'],
    ["\\frac{a}", "\\frac"],
    ["a \\ b", "\\ names no symbol"],
    ["x^{\\alpha}", "\\alpha"], // Greek has no raised form
    ["\\frac{x_q}{b}", '"q"'], // inside a group counts as inside the source

    // First, not last: a person is being asked whether this cell can be saved,
    // and one symbol they can act on is the useful answer.
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

// render is total, and what it cannot draw it copies through. A .unof can be
// edited by hand and a later release can narrow the subset, so render will meet
// sources supported would refuse; a cell showing a backslash can be recovered
// from, and one that quietly swallowed half of what someone typed cannot.
describe("render keeps what it cannot draw", () => {
  const cases: Array<[string, string]> = [
    ["x_q", "x_q"],
    ["\\arctan{x}", "\\arctan{x}"],
    ["\\sqrt{x^2}", "\\sqrt{x²}"], // refused, and still draws what it can
    ["\\sum_{i=1}^{n}", "\\sumᵢ₌₁ⁿ"], // the loss the font measurement caused, in full
    ["x^{\\alpha} y_2", "x^{\\alpha} y₂"], // the refused script survives whole
  ];

  for (const [src, want] of cases) {
    test(JSON.stringify(src), () => {
      expect(render(src)).toBe(want);
    });
  }
});

// Every entry in the tables has to be reachable from something a person could
// type. A mistyped key is a symbol that is in the subset by one reckoning and
// unreachable by anyone else's.
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

// The two tables answer separately, so nothing is both drawable and refused. A
// name in both would make render and supported disagree about the same cell.
test("no name is both drawable and refused", () => {
  for (const name of NO_GLYPH.keys()) {
    expect(SYMBOLS.has(name), `\\${name} is refused and also drawn`).toBe(false);
  }
});
