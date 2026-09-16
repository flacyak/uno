import { describe, expect, test } from "vite-plus/test";

import {
  MAX_PARTS,
  MAX_STEPS,
  type MatchPos,
  type ReplaceStep,
  type SliceStep,
  apply,
  describe as describeProgram,
  newReplace,
  parse,
  text,
} from "../../src/program/index.ts";

// parse then text gives back the same source.
describe("the text form round-trips", () => {
  const corpus = [
    'replace(/,/, "")',
    'replace(/[$,]/, "")',
    'replace(/\\s+/, " ")',
    'replace(/\\//, "-")',
    "trim()",
    "upper()",
    "lower()",
    "slice(0, -1)",
    "slice(end(/\\(/, 1), start(/\\)/, 1))",
    'trim() | replace(/%$/, "")',
    'trim() | replace(/,/, "") | upper()',
  ];

  for (const src of corpus) {
    test(src, () => {
      const p = parse(src);
      expect(text(p)).toBe(src);
      expect(() => parse(text(p))).not.toThrow();
    });
  }
});

describe("apply", () => {
  const cases: Array<[string, string, string]> = [
    ['replace(/,/, "")', "1,204", "1204"],
    ['replace(/,/, "")', "1,204,567", "1204567"], // every occurrence
    ['replace(/,/, "")', "987", "987"], // a miss leaves it unchanged
    ['replace(/[$,]/, "")', "$1,204", "1204"],
    ['replace(/%$/, "")', "12%", "12"],
    ['replace(/%$/, "")', "1%2", "1%2"], // anchored to the end
    ["trim()", "  1204 ", "1204"],
    ["upper()", "west", "WEST"],
    ["lower()", "West", "west"],
    ["slice(0, -1)", "1204x", "1204"],
    ["slice(1, 3)", "abcde", "bc"],
    ["slice(end(/\\(/, 1), start(/\\)/, 1))", "Ada (West)", "West"],
    ["slice(end(/\\(/, 1), start(/\\)/, 1))", "Ada Okafor", "Ada Okafor"], // a miss leaves it unchanged
    ['trim() | replace(/,/, "")', " 1,204 ", "1204"],
    ["slice(0, -1)", "é1", "é"], // positions are code points
    ['replace(/\\d*/, "#")', "a12b", "#a#b#"], // Go's empty-match rule
    ['replace(/\\d*/, "#")', "12", "#"], // the trailing empty match is skipped
  ];

  for (const [src, input, want] of cases) {
    test(`${src} / ${input}`, () => {
      expect(apply(parse(src), input)).toBe(want);
    });
  }
});

// The replacement is literal text.
test("a replacement is literal text", () => {
  expect(apply(parse('replace(/x/, "$1")'), "x")).toBe("$1");
});

// A pattern source that already escapes the slash is written with one
// spelling and parses back to the same program.
test("a pattern that escapes the slash itself round-trips", () => {
  for (const src of ["\\/", "a\\/b", "\\\\/"]) {
    const t = text([newReplace(src, "-")]);
    expect(text(parse(t))).toBe(t);
    expect(apply(parse(t), "a/b\\")).toBe(apply([newReplace(src, "-")], "a/b\\"));
  }
});

// Each step holds one RegExp compiled with the global flag, and applying it
// to one cell leaves it ready for the next.
describe("a step's pattern is compiled global, once", () => {
  const replace = parse('replace(/,/, "")')[0] as ReplaceStep;
  const slice = parse("slice(end(/,/, 1), start(/,/, -1))")[0] as SliceStep;

  test("replace holds the global pattern", () => {
    expect(replace.re.global).toBe(true);
  });

  test("a match position holds the global pattern", () => {
    expect((slice.from as MatchPos).re.global).toBe(true);
    expect((slice.to as MatchPos).re.global).toBe(true);
  });

  test("no match state leaks between cells", () => {
    const cells = ["1,204,567", "1,204", "987", "1,204,567", ",,", ""];
    const want = cells.map((v) => apply(parse('replace(/,/, "")'), v));
    expect(cells.map((v) => apply([replace], v))).toEqual(want);
    expect(cells.map((v) => apply([replace], v))).toEqual(want);

    const between = cells.map((v) => apply(parse("slice(end(/,/, 1), start(/,/, -1))"), v));
    expect(cells.map((v) => apply([slice], v))).toEqual(between);
    expect(cells.map((v) => apply([slice], v))).toEqual(between);
  });
});

// parse throws on a program that is incomplete, malformed or too long.
describe("parse refuses what it cannot run", () => {
  const corpus = [
    "",
    "replace(/,/)",
    'replace(/,/, "",)',
    'replace(,, "")',
    'replace(/[/, "")', // an uncompilable pattern
    "explode()",
    "trim",
    "trim()) ",
    'replace(/,/, "") | ',
    Array.from({ length: MAX_STEPS + 1 }, () => "trim()").join(" | "),
    "slice(0)",
    "slice(start(/a/, 0), 1)", // matches are counted from 1
    'replace(/,/, ")',
    'replace(/,, "")',
  ];

  for (const src of corpus) {
    test(JSON.stringify(src), () => {
      expect(() => parse(src)).toThrow();
    });
  }
});

// The error position is the step name's offset in code points.
test("an unknown step is placed at its name", () => {
  expect(() => parse("explode()")).toThrow(/at character 1/);
  expect(() => parse("  explode ()")).toThrow(/at character 3/);
  expect(() => parse("trim() | \u{1D522}()")).toThrow(/at character 10/);
});

// describe gives an English description for the shapes the recogniser
// proposes, and falls back to the program text for the rest.
describe("describe", () => {
  const cases: Array<[string, string]> = [
    ['replace(/,/, "")', "remove commas"],
    ['replace(/[$,]/, "")', "remove dollar signs and commas"],
    ['replace(/[$, ]/, "")', "remove dollar signs, commas and spaces"],
    ['replace(/,/, ".")', 'replace commas with "."'],
    ["trim()", "trim the spaces off both ends"],
    ['trim() | replace(/,/, "")', "trim the spaces off both ends, then remove commas"],
    ["upper()", "upper-case it"],

    // Literals and anchored character classes.
    ['replace(/ kg/, "")', 'remove " kg"'],
    ['replace(/SKU-/, "")', 'remove "SKU-"'],
    ['replace(/[*]+$/, "")', "remove asterisks from the end"],
    ['replace(/^[#]+/, "")', "remove hashes from the start"],
    ['replace(/\\//, "-")', 'replace slashes with "-"'],
    ['replace(/[ ()\\-]/, "")', "remove spaces, brackets and dashes"],

    // These fall back to the program text as their description.
    ['replace(/\\d/, "")', 'replace(/\\d/, "")'],
    ['replace(/[^,]/, "")', 'replace(/[^,]/, "")'],
    ['replace(/\\s+/, " ")', 'replace(/\\s+/, " ")'],
    ["slice(0, -1)", "slice(0, -1)"],
  ];

  for (const [src, want] of cases) {
    test(src, () => {
      expect(describeProgram(parse(src))).toBe(want);
    });
  }
});

// concat joins parts of the value in a new order.
test("concat rearranges", () => {
  const src = 'concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))';
  const p = parse(src);
  expect(text(p)).toBe(src);
  expect(apply(p, "Okafor, Ada")).toBe("Ada Okafor");
});

// A concat changes the value only when every part matches.
test("a concat that does not fit leaves the value alone", () => {
  const p = parse('concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))');
  expect(apply(p, "Ada Okafor")).toBe("Ada Okafor");
});

// A pipeline changes the value only when every step matches.
test("a pipeline that breaks part way through changes nothing", () => {
  const p = parse("trim() | slice(start(/\\(/, 1), 99)");
  expect(apply(p, "  no bracket  ")).toBe("  no bracket  ");
});

describe("concat parse refusals", () => {
  const corpus = [
    'concat("only")', // needs at least two parts
    "concat(slice(0, 1))", // needs at least two parts
    'concat(trim(), "x")', // a part is a string or a slice
    `concat(${Array.from({ length: MAX_PARTS + 1 }, () => '"a"').join(", ")})`,
    'concat("a",)',
  ];

  for (const src of corpus) {
    test(src, () => {
      expect(() => parse(src)).toThrow();
    });
  }
});
