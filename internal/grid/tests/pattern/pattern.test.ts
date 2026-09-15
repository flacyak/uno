import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vite-plus/test";

import { read } from "../../src/ingest/index.ts";
import { SAMPLE_SIZE, Survey, gather, snap } from "../../src/pattern/index.ts";
import type { Proposal } from "../../src/pattern/index.ts";
import {
  apply as applyProgram,
  describe as describeProgram,
  text,
} from "../../src/program/index.ts";
import { Sheet } from "../../src/sheet/index.ts";

/** A sheet of a single column, which is the shape most of what the recogniser
 * does is about. */
function oneCol(header: string, ...values: string[]): Sheet {
  return new Sheet(
    "test.csv",
    [header],
    values.map((v) => [v]),
  );
}

function propose(s: Sheet): Proposal | undefined {
  return snap(s).propose();
}

/**
 * The file the preview is filmed from, which is the case the whole recogniser
 * exists for: 3,152 of 4,812 rows in units wear a thousands separator, and
 * fixing them by hand is the work uno is meant to remove.
 */
function sales(): Sheet {
  const path = fileURLToPath(new URL("../testdata/sales-q3.csv", import.meta.url));
  return read("sales-q3.csv", readFileSync(path));
}

const UNITS_COL = 4;

test("three fixed cells propose the rest", () => {
  const s = sales();
  expect(s.columns[UNITS_COL]!.flagged, "the warning badge should start on").toBe(true);

  // Rows 0, 2 and 4 are the first three holding a separator.
  s.set(0, UNITS_COL, "1204");
  s.set(2, UNITS_COL, "1455");
  s.set(4, UNITS_COL, "2038");

  const p = propose(s);
  expect(p, "no proposal after three consistent edits").toBeDefined();
  expect(p!.col).toBe(UNITS_COL);
  expect(p!.header).toBe("units");
  expect(text(p!.prog)).toBe('replace(/,/, "")');
  expect(describeProgram(p!.prog)).toBe("remove commas");

  // 3,152 rows carry a separator and three of them have been fixed by hand.
  // Offering to redo those would count the person's own work as the app's.
  expect(p!.affects).toBe(3149);
  expect(p!.ambiguous, "want a confident proposal").toBe(false);
  expect(p!.sample).toHaveLength(SAMPLE_SIZE);
  for (const c of p!.sample) expect(c.was, `sample row ${c.row}`).not.toBe(c.now);
});

// Applying the proposal is what ends it: nothing in the column still matches,
// so the recogniser has nothing left to ask about and does not nag.
test("applying a proposal settles the column", () => {
  const s = sales();
  s.set(0, UNITS_COL, "1204");
  s.set(2, UNITS_COL, "1455");
  s.set(4, UNITS_COL, "2038");

  const p = propose(s);
  expect(p).toBeDefined();
  s.apply(p!.col, p!.prog);

  expect(s.columns[UNITS_COL]!.kind).toBe("num");
  expect(s.columns[UNITS_COL]!.flagged).toBe(false);
  expect(propose(s), "a second proposal after the column was fixed").toBeUndefined();
});

// The engine reads a column a block at a time and asks for the proposal as it
// stands. Fed that way to the end, a survey has to ask exactly what one pass over
// the whole column asks, sample and ambiguity included.
test("a survey fed in pieces proposes what one pass does", () => {
  const s = sales();
  s.set(0, UNITS_COL, "1204");
  s.set(2, UNITS_COL, "1455");
  s.set(4, UNITS_COL, "2038");
  const whole = propose(s)!;

  const values = Array.from({ length: s.rows() }, (_, row) => s.raw(row, UNITS_COL));
  const written = Array.from({ length: s.rows() }, (_, row) => s.written(row, UNITS_COL));
  const survey = Survey.start(UNITS_COL, "units", gather(s.edits()).get(UNITS_COL)!)!;

  let partial: Proposal | undefined;
  for (let first = 0; first < values.length; first += 7) {
    survey.add(values.slice(first, first + 7), first, written.slice(first, first + 7));
    if (first === 700) partial = survey.proposal();
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

// Not every fix changes characters. Pulling the code out of the middle of a
// cell leaves every character it keeps exactly as it was, and no amount of
// replacing describes it.
test("proposes an extraction", () => {
  const s = oneCol("rep", "Ada (West)", "Ben (East)", "Cai (North)", "Dee (South)", "Eli (West)");
  s.set(0, 0, "West");
  s.set(1, 0, "East");
  s.set(2, 0, "North");

  const p = propose(s);
  expect(p, "no proposal from three extractions").toBeDefined();
  expect(applyProgram(p!.prog, "Dee (South)")).toBe("South");
  expect(applyProgram(p!.prog, "Eli (West)")).toBe("West");
  expect(p!.affects).toBe(2);
});

// The same characters in a different order is the case a pipeline of rewrites
// cannot reach at all.
test("proposes a reordering", () => {
  const s = oneCol("rep", "Okafor, Ada", "Iyer, Ben", "Moreau, Cai", "Nakamura, Dee");
  s.set(0, 0, "Ada Okafor");
  s.set(1, 0, "Ben Iyer");
  s.set(2, 0, "Cai Moreau");

  const p = propose(s);
  expect(p, "no proposal from three reorderings").toBeDefined();
  expect(applyProgram(p!.prog, "Nakamura, Dee")).toBe("Dee Nakamura");
});

// A cell holding prose has no convention in it to induce from, and aligning two
// paragraphs is work spent to discover that.
test("very long values are not aligned", () => {
  const long = "a,".repeat(200);
  const s = oneCol("note", long, long, long, long);
  s.set(0, 0, long.replaceAll(",", ""));
  s.set(1, 0, long.replaceAll(",", ""));
  s.set(2, 0, long.replaceAll(",", ""));

  expect(propose(s)).toBeUndefined();
});

test("space at both ends is a trim", () => {
  const s = oneCol("qty", " 45 ", "  7 ", " 120  ", " 9 ");
  s.set(0, 0, "45");
  s.set(1, 0, "7");
  s.set(2, 0, "120");

  // Removing every space and trimming the ends agree on every value in this
  // column, so it cannot say which was meant. What this pins is that there is
  // an offer at all.
  const p = propose(s);
  expect(p, "no proposal from three trims").toBeDefined();
  expect(applyProgram(p!.prog, " 9 ")).toBe("9");
});

// The value that separates trimming the ends from removing every space.
test("trimming a name column", () => {
  const s = oneCol("rep", " Ada Okafor ", " Bo Silva ", " Cy Tan ", " Di Vaz ");
  s.set(0, 0, "Ada Okafor");
  s.set(1, 0, "Bo Silva");
  s.set(2, 0, "Cy Tan");

  const p = propose(s);
  expect(p, "no proposal from three trims").toBeDefined();
  expect(text(p!.prog)).toBe("trim()");
  expect(applyProgram(p!.prog, " Di Vaz ")).toBe("Di Vaz");
});

// A date column is the other one whose badge a fix can flip.
test("proposes a date separator", () => {
  const s = oneCol("closed", "2026/09/03", "2025/01/11", "2024/12/30", "2026/07/04");
  s.set(0, 0, "2026-09-03");
  s.set(1, 0, "2025-01-11");
  s.set(2, 0, "2024-12-30");

  const p = propose(s);
  expect(p, "no proposal from three date separators").toBeDefined();
  // The literal and the class both explain the examples and agree on every
  // value in the column, so the tiebreak picks between them and this pins
  // which one it picks.
  expect(text(p!.prog)).toBe('replace(/[\\/]+/, "-")');

  s.apply(p!.col, p!.prog);
  expect(s.columns[0]!.kind).toBe("date");
});

// The decoration a column wears is not worn by every row in it, and the three
// rows a person demonstrates on are not chosen to be representative.
test("one demonstration cell without the separator", () => {
  const s = oneCol("amount", "$1,204", "$87", "$3,010", "$450", "$12,900");
  s.set(0, 0, "1204");
  s.set(1, 0, "87"); // under a thousand: no comma to remove
  s.set(2, 0, "3010");

  const p = propose(s);
  expect(p, "no proposal from three currency fixes").toBeDefined();
  expect(text(p!.prog)).toBe('replace(/[$,]/, "")');
  expect(applyProgram(p!.prog, "$12,900")).toBe("12900");
});

test("proposes a parenthesised negative", () => {
  const s = oneCol("delta", "(1,204)", "(87)", "(3,010)", "(450)");
  s.set(0, 0, "-1204");
  s.set(1, 0, "-87");
  s.set(2, 0, "-3010");

  const p = propose(s);
  expect(p, "no proposal from three parenthesised negatives").toBeDefined();
  expect(p!.prog, `${text(p!.prog)} should be two steps`).toHaveLength(2);
  expect(applyProgram(p!.prog, "(450)")).toBe("-450");
});

test("proposes a European decimal", () => {
  const s = oneCol("amount", "1.204,50", "9.870,25", "2.000,00", "3.150,75");
  s.set(0, 0, "1204.50");
  s.set(1, 0, "9870.25");
  s.set(2, 0, "2000.00");

  const p = propose(s);
  expect(p, "no proposal from three European decimals").toBeDefined();
  expect(applyProgram(p!.prog, "3.150,75")).toBe("3150.75");
});

// A one-step answer keeps its precedence over a two-step one.
test("commas stay one step", () => {
  const s = oneCol("units", "1,204", "9,870", "3,010", "5,500");
  s.set(0, 0, "1204");
  s.set(1, 0, "9870");
  s.set(2, 0, "3010");

  const p = propose(s);
  expect(p).toBeDefined();
  expect(p!.prog).toHaveLength(1);
});

// Each row is three demonstrated edits, the program they induce, and one
// untouched value the program then claims.
describe("the shapes the recogniser reaches", () => {
  const cases: Array<{
    name: string;
    values: string[]; // the column; the first three get edited
    fixed: string[]; // what the person typed into them
    want: string; // the program, in its text form
    in: string; // a value nobody touched
    out: string; // and what applying does to it
  }> = [
    {
      name: "commas",
      values: ["1,204", "9,870", "3,010", "5,500"],
      fixed: ["1204", "9870", "3010"],
      want: 'replace(/,/, "")',
      in: "5,500",
      out: "5500",
    },
    {
      name: "currency",
      values: ["$1,204", "$87", "$3,010", "$5,500"],
      fixed: ["1204", "87", "3010"],
      want: 'replace(/[$,]/, "")',
      in: "$5,500",
      out: "5500",
    },
    {
      name: "percent",
      values: ["12.5%", "3%", "88.1%", "40%"],
      fixed: ["12.5", "3", "88.1"],
      want: 'replace(/%/, "")',
      in: "40%",
      out: "40",
    },
    {
      name: "units",
      values: ["45 kg", "7 kg", "120 kg", "9 kg"],
      fixed: ["45", "7", "120"],
      want: 'replace(/ kg/, "")',
      in: "9 kg",
      out: "9",
    },
    {
      name: "footnote",
      values: ["1204*", "87*", "310*", "55*"],
      fixed: ["1204", "87", "310"],
      want: 'replace(/[*]+$/, "")',
      in: "55*",
      out: "55",
    },
    {
      name: "swiss separator",
      values: ["1'204", "9'870", "2'000", "3'150"],
      fixed: ["1204", "9870", "2000"],
      want: 'replace(/\'/, "")',
      in: "3'150",
      out: "3150",
    },
    {
      name: "id prefix",
      values: ["SKU-00421", "SKU-00887", "SKU-01930", "SKU-00042"],
      fixed: ["00421", "00887", "01930"],
      want: 'replace(/SKU-/, "")',
      in: "SKU-00042",
      out: "00042",
    },
    {
      name: "phone",
      values: ["(555) 123-4567", "(212) 999-1000", "(310) 555-0101", "(415) 200-3000"],
      fixed: ["5551234567", "2129991000", "3105550101"],
      want: 'replace(/[ ()\\-]/, "")',
      in: "(415) 200-3000",
      out: "4152003000",
    },
    {
      name: "case fold",
      values: ["ca", "ny", "tx", "wa"],
      fixed: ["CA", "NY", "TX"],
      want: "upper()",
      in: "wa",
      out: "WA",
    },
    {
      // "after the last @" and "after the first @" agree on every value here,
      // so the tiebreak picks between them and this pins which.
      name: "email domain",
      values: ["ada@corp.com", "bo@acme.io", "cy@x.net", "di@q.org"],
      fixed: ["corp.com", "acme.io", "x.net"],
      want: "slice(end(/@/, -1), len)",
      in: "di@q.org",
      out: "q.org",
    },
    {
      // A name column rather than a quantity one: the interior space is what
      // separates trimming the ends from removing every space.
      name: "trim",
      values: [" Ada Okafor ", " Bo Silva ", " Cy Tan ", " Di Vaz "],
      fixed: ["Ada Okafor", "Bo Silva", "Cy Tan"],
      want: "trim()",
      in: " Di Vaz ",
      out: "Di Vaz",
    },
    {
      name: "date separator",
      values: ["2026/09/03", "2025/01/11", "2024/12/30", "2026/07/04"],
      fixed: ["2026-09-03", "2025-01-11", "2024-12-30"],
      want: 'replace(/[\\/]+/, "-")',
      in: "2026/07/04",
      out: "2026-07-04",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const s = oneCol("col", ...c.values);
      c.fixed.forEach((v, row) => s.set(row, 0, v));

      const p = propose(s);
      expect(p, "no proposal from three edits").toBeDefined();
      expect(text(p!.prog)).toBe(c.want);
      expect(applyProgram(p!.prog, c.in)).toBe(c.out);
    });
  }
});
