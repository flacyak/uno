// What the recogniser takes as evidence, and when it stays quiet.

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

  // Rows 0, 2 and 4 are the first three holding a separator.
  s.set(0, UNITS, "1204");
  s.set(2, UNITS, "1455");
  s.set(4, UNITS, "2038");

  const p = propose(s);
  expect(p, "no proposal after three consistent edits").toBeDefined();
  expect(p!.col).toBe(UNITS);
  expect(p!.header).toBe("units");
  expect(text(p!.prog)).toBe('replace(/,/, "")');
  expect(describeProgram(p!.prog)).toBe("remove commas");

  // 3,152 rows carry a separator and three of them have been fixed by hand.
  // Offering to redo those would count the person's own work as the app's.
  expect(p!.affects).toBe(COMMAS_LEFT);
  expect(p!.ambiguous, "want a confident proposal").toBe(false);
  expect(p!.sample).toHaveLength(SAMPLE_SIZE);
  for (const c of p!.sample) expect(c.was, `sample row ${c.row}`).not.toBe(c.now);
});

// Applying the proposal is what ends it: nothing in the column still matches,
// so the recogniser has nothing left to ask about and does not nag.
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

// The engine reads a column a block at a time and asks for the proposal as it
// stands. Fed that way to the end, a survey has to ask exactly what one pass over
// the whole column asks, sample and ambiguity included.
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

// The runner-up only disagrees in the last value, so the classes have to carry
// every agreement until then.
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

// Two is a coincidence often enough to be annoying. The third is the one that
// says this is a habit.
test("two examples are not enough", () => {
  const s = oneCol("units", "1,204", "987", "1,455", "2,038");
  s.set(0, 0, "1204");
  s.set(2, 0, "1455");

  expect(propose(s)).toBeUndefined();
});

// Someone fixing a column wanders off to another one and comes back. A
// recogniser that only read the tail of the log would never see the pattern.
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
  s.set(0, 0, "west"); // a detour into another column
  s.set(2, 1, "1455");
  s.set(1, 0, "east");
  s.set(3, 1, "2038");

  const p = propose(s);
  expect(p, "no proposal from three nonconsecutive edits").toBeDefined();
  expect(p!.col).toBe(1);
  expect(text(p!.prog)).toBe('replace(/,/, "")');
});

// A cell edited twice contributes one example, from what it held before the
// first edit to what it holds after the last. The value in between was a
// keystroke, not a demonstration.
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

// A value typed and then typed back is not a demonstration of anything.
test("a cell edited back is not an example", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "2038x");
  s.set(2, 0, "2,038"); // back to where it started

  expect(propose(s)).toBeUndefined();
});

// A program has to reproduce every example, not most of them. One edit that
// does not fit is the person saying the rule is not what it looked like.
test("one inconsistent example sinks the proposal", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "3,001");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "n/a");

  expect(propose(s)).toBeUndefined();
});

// Remove commas leaves a fixed cell as it is, so it never showed: the count has
// to leave out cells already fixed whatever the program would do to them again.
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

// The examples an apply generalised describe characters that are no longer
// there. Reading them again would be inducing a rule from the results of a rule.
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

// The examples do not always settle which rule was meant. When the runner-up
// parts company with the winner somewhere in the column, the offer has to say
// so rather than pick and hope.
test("a runner-up that disagrees makes it ambiguous", () => {
  // Every example loses a trailing comma. Whether that means "the trailing one"
  // or "all of them" is not decidable from these three, and the column holds a
  // row where the two answers differ.
  const s = oneCol("code", "AB,", "CD,", "EF,", "G,H,", "J,K");
  s.set(0, 0, "AB");
  s.set(1, 0, "CD");
  s.set(2, 0, "EF");

  const p = propose(s);
  expect(p).toBeDefined();
  expect(p!.ambiguous, `${text(p!.prog)} is not marked ambiguous`).toBe(true);

  // The narrower claim wins: removing the trailing comma leaves the one in the
  // middle of G,H alone, and rewriting it was never demonstrated.
  expect(applyProgram(p!.prog, "G,H,")).toBe("G,H");
  expect(applyProgram(p!.prog, "J,K")).toBe("J,K");
});

// Not every consistent edit is a transformation. Three cells typed over with
// unrelated values describe nothing, and the right answer is silence.
test("unrelated edits propose nothing", () => {
  const s = oneCol("note", "alpha", "beta", "gamma", "delta");
  s.set(0, 0, "one");
  s.set(1, 0, "two");
  s.set(2, 0, "three");

  expect(propose(s)).toBeUndefined();
});

// A program that explains the examples and claims nothing else is not a
// question worth asking.
test("nothing left to change proposes nothing", () => {
  const s = oneCol("units", "1,204", "1,455", "2,038", "987");
  s.set(0, 0, "1204");
  s.set(1, 0, "1455");
  s.set(2, 0, "2038");

  expect(propose(s)).toBeUndefined();
});

// A cell holding prose has no convention in it to induce from, and aligning two
// paragraphs is work spent to discover that.
test("very long values are not aligned", () => {
  const long = "a,".repeat(MAX_DIFF + 1);
  const s = oneCol("note", long, long, long, long);
  s.set(0, 0, long.replaceAll(",", ""));
  s.set(1, 0, long.replaceAll(",", ""));
  s.set(2, 0, long.replaceAll(",", ""));

  expect(propose(s)).toBeUndefined();
});
