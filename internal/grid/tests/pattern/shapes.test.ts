// The programs the recogniser proposes, one shape of fix at a time.

import { describe, expect, test } from "vite-plus/test";

import { apply as applyProgram, text } from "../../src/program/index.ts";
import { oneCol, propose } from "./harness.ts";

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
