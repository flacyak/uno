import { describe, expect, test } from "vite-plus/test";

import { apply, describe as describeProgram, parse, text } from "../../src/program/index.ts";

// The text form is what a .uno carries, so a program that has been through a
// file has to be the program that went in.
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
    ['replace(/,/, "")', "1,204,567", "1204567"], // every occurrence, not the first
    ['replace(/,/, "")', "987", "987"], // no match leaves it alone
    ['replace(/[$,]/, "")', "$1,204", "1204"],
    ['replace(/%$/, "")', "12%", "12"],
    ['replace(/%$/, "")', "1%2", "1%2"], // anchored, so the middle one stays
    ["trim()", "  1204 ", "1204"],
    ["upper()", "west", "WEST"],
    ["lower()", "West", "west"],
    ["slice(0, -1)", "1204x", "1204"],
    ["slice(1, 3)", "abcde", "bc"],
    ["slice(end(/\\(/, 1), start(/\\)/, 1))", "Ada (West)", "West"],
    ["slice(end(/\\(/, 1), start(/\\)/, 1))", "Ada Okafor", "Ada Okafor"], // no bracket, left alone
    ['trim() | replace(/,/, "")', " 1,204 ", "1204"],
    ["slice(0, -1)", "é1", "é"], // code points, not bytes
  ];

  for (const [src, input, want] of cases) {
    test(`${src} / ${input}`, () => {
      expect(apply(parse(src), input)).toBe(want);
    });
  }
});

// A replacement is text. A value someone typed that happens to read like a
// capture reference has to survive being written back.
test("a replacement is literal text", () => {
  expect(apply(parse('replace(/x/, "$1")'), "x")).toBe("$1");
});

// A log that does not parse must say so before a column is rewritten, not
// halfway through one.
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
    "trim() | trim() | trim() | trim()", // past MAX_STEPS
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

// The banner asks the question in words, so the words have to be right for what
// the recogniser actually proposes, and absent rather than approximate for the
// rest.
describe("describe", () => {
  const cases: Array<[string, string]> = [
    ['replace(/,/, "")', "remove commas"],
    ['replace(/[$,]/, "")', "remove dollar signs and commas"],
    ['replace(/[$, ]/, "")', "remove dollar signs, commas and spaces"],
    ['replace(/,/, ".")', 'replace commas with "."'],
    ["trim()", "trim the spaces off both ends"],
    ['trim() | replace(/,/, "")', "trim the spaces off both ends, then remove commas"],
    ["upper()", "upper-case it"],

    // A literal the escaping in the lattice can be inverted out of, and the
    // anchored class rungs that lattice emits.
    ['replace(/ kg/, "")', 'remove " kg"'],
    ['replace(/SKU-/, "")', 'remove "SKU-"'],
    ['replace(/[*]+$/, "")', "remove asterisks from the end"],
    ['replace(/^[#]+/, "")', "remove hashes from the start"],
    ['replace(/\\//, "-")', 'replace slashes with "-"'],
    ['replace(/[ ()\\-]/, "")', "remove spaces, brackets and dashes"],

    // Nothing in the vocabulary names these, so they fall back to notation
    // rather than to a description that glosses over what they do.
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

// A concat is what the other steps cannot do: the same characters in a
// different order.
test("concat rearranges", () => {
  const src = 'concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))';
  const p = parse(src);
  expect(text(p)).toBe(src);
  expect(apply(p, "Okafor, Ada")).toBe("Ada Okafor");
});

// A part that does not fit abandons the whole step. A name reassembled from the
// half of it that parsed is a worse answer than the name already there.
test("a concat that does not fit leaves the value alone", () => {
  const p = parse('concat(slice(end(/, /, 1), len), " ", slice(0, start(/,/, 1)))');
  expect(apply(p, "Ada Okafor")).toBe("Ada Okafor");
});

// A program applies wholly or not at all. Half-transforming a cell would leave
// data in a state no program describes.
test("a pipeline that breaks part way through changes nothing", () => {
  const p = parse("trim() | slice(start(/\\(/, 1), 99)");
  expect(apply(p, "  no bracket  ")).toBe("  no bracket  ");
});

describe("concat parse refusals", () => {
  const corpus = [
    'concat("only")', // one part is that part
    "concat(slice(0, 1))", // likewise
    'concat(trim(), "x")', // a part is a piece, not a step
    'concat("a", "b", "c", "d", "e")', // past MAX_PARTS
    'concat("a",)',
  ];

  for (const src of corpus) {
    test(src, () => {
      expect(() => parse(src)).toThrow();
    });
  }
});
