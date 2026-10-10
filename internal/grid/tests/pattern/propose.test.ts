// Tests for which edits count as evidence for a proposal, and when propose
// returns undefined.

import { expect, test } from "vite-plus/test";

import { MAX_DIFF, SAMPLE_SIZE, Survey, gather, snap } from "../../src/pattern/index.ts";
import type { Proposal } from "../../src/pattern/index.ts";
import {
  apply as applyProgram,
  describe as describeProgram,
  text,
} from "../../src/program/index.ts";
import { Sheet } from "../../src/sheet/index.ts";
import { COMMAS_LEFT, UNITS } from "../testdata/sales-q3.ts";
import { oneCol, propose, sales } from "./harness.ts";

test("three fixed cells propose the rest", () => {
  const s = sales();
  expect(s.columns[UNITS]!.flagged, "the warning badge should start on").toBe(true);

  // Rows 0, 2 and 4 are the first three rows with a separator.
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");

  const p = propose(s);
  expect(p, "no proposal after three consistent edits").toBeDefined();
  expect(p!.col).toBe(UNITS);
  expect(p!.header).toBe("units");
  expect(text(p!.prog)).toBe('replace(/,/, "")');
  expect(describeProgram(p!.prog)).toBe("remove commas");

  // affects counts the rows with a separator minus the three fixed by hand.
  expect(p!.affects).toBe(COMMAS_LEFT);
  expect(p!.ambiguous, "want a confident proposal").toBe(false);
  expect(p!.sample).toHaveLength(SAMPLE_SIZE);
  for (const c of p!.sample) expect(c.was, `sample row ${c.row}`).not.toBe(c.now);
});

// After the proposal is applied, propose returns undefined.
test("applying a proposal settles the column", () => {
  const s = sales();
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");

  const p = propose(s);
  expect(p).toBeDefined();
  s.apply(p!.col, p!.prog);

  expect(s.columns[UNITS]!.kind).toBe("num");
  expect(s.columns[UNITS]!.flagged).toBe(false);
  expect(propose(s), "a second proposal after the column was fixed").toBeUndefined();
});

// A Survey fed the column in small pieces ends with the same proposal as one
// pass over the whole column, sample and ambiguity included. A proposal taken
// part way through has a smaller affects count.
test("a survey fed in pieces proposes what one pass does", () => {
  const s = sales();
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");
  const whole = propose(s)!;

  const values = Array.from({ length: s.rows() }, (_, row) => s.raw(row, UNITS));
  const written = Array.from({ length: s.rows() }, (_, row) => s.written(row, UNITS));
  const survey = Survey.start(UNITS, "units", gather(s.edits()).get(UNITS)!)!;

  const piece = 7;
  const partWay = 100 * piece;
  let partial: Proposal | undefined;
  for (let first = 0; first < values.length; first += piece) {
    survey.add(values.slice(first, first + piece), first, written.slice(first, first + piece));
    if (first === partWay) partial = survey.proposal();
  }

  expect(partial, "no proposal part of the way through").toBeDefined();
  expect(partial!.affects, "the partial count should be a lower bound").toBeLessThan(whole.affects);
  expect(survey.rows).toBe(values.length);
  expect(survey.proposal()).toEqual(whole);
});

// The runner-up program disagrees only on the last value fed to the survey,
// and the proposal is still marked ambiguous.
test("ambiguity found in the last piece still counts", () => {
  const s = oneCol("code", "AB,", "CD,", "EF,", "XY,", "G,H,");
  s.set(0, 0, "AB");
  s.set(1, 0, "CD");
  s.set(2, 0, "EF");
  const whole = propose(s)!;
  expect(whole.ambiguous).toBe(true);

  const survey = Survey.start(0, "code", gather(s.edits()).get(0)!)!;
  for (let row = 0; row < s.rows(); row++) survey.add([s.raw(row, 0)], row, [s.written(row, 0)]);
  expect(survey.proposal()).toEqual(whole);
});

// Three examples are needed for a proposal.
test("two examples are not enough", () => {
  const s = oneCol("units", "1,204", "987", "1,455", "2,038");
  s.set(0, 0, "1204");
  s.set(2, 0, "1455");

  expect(propose(s)).toBeUndefined();
});

// Edits to other columns between the examples leave the pattern intact.
test("examples need not be adjacent in the log", () => {
  const s = new Sheet(
    "t.csv",
    ["region", "units"],
    [
      ["West", "1,204"],
      ["East", "987"],
      ["North", "1,455"],
      ["South", "2,038"],
      ["West", "3,120"],
      ["East", "4,001"],
    ],
  );

  s.set(0, 1, "1204");
  s.set(0, 0, "west"); // an edit in another column
  s.set(2, 1, "1455");
  s.set(1, 0, "east");
  s.set(3, 1, "2038");

  const p = propose(s);
  expect(p, "no proposal from three nonconsecutive edits").toBeDefined();
  expect(p!.col).toBe(1);
  expect(text(p!.prog)).toBe('replace(/,/, "")');
});

// A cell edited twice is one example: its original value to its final value.
test("repeated edits of one cell are one example", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204x");
  s.set(0, 0, "1204"); // corrected in place
  s.set(1, 0, "1455");
  s.set(2, 0, "2038");

  const p = propose(s);
  expect(p).toBeDefined();
  expect(text(p!.prog)).toBe('replace(/,/, "")');
});

// A cell edited back to its original value drops out of the examples.
test("a cell edited back is not an example", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "2038x");
  s.set(2, 0, "2,038"); // back to where it started

  expect(propose(s)).toBeUndefined();
});

// The program must reproduce every example. One mismatch means propose
// returns undefined.
test("one inconsistent example sinks the proposal", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "n/a");

  expect(propose(s)).toBeUndefined();
});

// affects and sample leave out the hand-fixed cells, even when the program
// would change them again. apply also leaves those cells alone.
test("cells fixed by hand are not counted, even by a program that is not idempotent", () => {
  const s = oneCol("region", "West", "East", "North", "South", "West");
  s.set(0, 0, "West-q3");
  s.set(1, 0, "East-q3");
  s.set(2, 0, "North-q3");

  const p = propose(s);
  expect(p).toBeDefined();
  expect(p!.affects).toBe(2);
  expect(p!.sample.map((c) => c.row)).toEqual([3, 4]);

  s.apply(0, p!.prog);
  expect([0, 1, 2, 3, 4].map((row) => s.raw(row, 0))).toEqual([
    "West-q3",
    "East-q3",
    "North-q3",
    "South-q3",
    "West-q3",
  ]);
});

// After apply, the set edits that led to it are spent as examples.
test("an applied column stops being evidence", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "2038");

  const p = propose(s);
  expect(p).toBeDefined();
  s.apply(0, p!.prog);

  expect(snap(s).empty(), "examples survived the apply").toBe(true);
});

// When the runner-up program gives a different result from the winner on some
// row of the column, the proposal is marked ambiguous.
test("a runner-up that disagrees makes it ambiguous", () => {
  // Every example loses a trailing comma. "Remove the trailing comma" and
  // "remove all commas" both fit, and they differ on "G,H,".
  const s = oneCol("code", "AB,", "CD,", "EF,", "G,H,", "J,K");
  s.set(0, 0, "AB");
  s.set(1, 0, "CD");
  s.set(2, 0, "EF");

  const p = propose(s);
  expect(p).toBeDefined();
  expect(p!.ambiguous, `${text(p!.prog)} is not marked ambiguous`).toBe(true);

  // The narrower program wins: only the trailing comma is removed.
  expect(applyProgram(p!.prog, "G,H,")).toBe("G,H");
  expect(applyProgram(p!.prog, "J,K")).toBe("J,K");
});

// Three unrelated edits make propose return undefined.
test("unrelated edits propose nothing", () => {
  const s = oneCol("note", "alpha", "beta", "gamma", "delta");
  s.set(0, 0, "one");
  s.set(1, 0, "two");
  s.set(2, 0, "three");

  expect(propose(s)).toBeUndefined();
});

// propose returns undefined when every untouched cell would stay as it is.
test("nothing left to change proposes nothing", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "987");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "2038");

  expect(propose(s)).toBeUndefined();
});

// Values longer than MAX_DIFF skip alignment, so propose returns undefined.
test("very long values are not aligned", () => {
  const long = "a,".repeat(MAX_DIFF + 1);
  const s = oneCol("note", long, long, long, long);
  s.set(0, 0, long.replaceAll(",", ""));
  s.set(1, 0, long.replaceAll(",", ""));
  s.set(2, 0, long.replaceAll(",", ""));

  expect(propose(s)).toBeUndefined();
});
