/**
 * @fileoverview What a chart's caption says of how much of its source it has
 * read, in the language chosen: the share read while its tally is partial, and
 * the rows once it is complete, then the cells the tally left out. And what its
 * plot says in place of a chart it cannot draw.
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { GroupsTally, SampleTally, Tally } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import type { Locale } from "@paraglide/runtime";
import { blank, body, coverage, notNumbers } from "@renderer/chart/caption";
import type { Heard } from "@renderer/charts";
import { BARS, SCATTER } from "../charted.ts";

/** The sales export's rows, and how many of them a tally two fifths through has read. */
const ROWS = 4812;
const READ = 1925;

/** The no-break space Intl writes between a number and its unit, so a label never wraps there. */
const NBSP = " ";

/** A tally of BARS that has read `rows` of `total`, complete once it has read every row. */
function tallyOf(rows: number, total: number, complete = rows === total): GroupsTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "groups",
    plot: BARS.plot,
    coverage: { rows, total, complete },
    groups: [],
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** The sales export's name, and a tally of a chart over it whose column the file has not. */
const NAME = "sales-q3.csv";
const UNREAD: Tally = {
  t: "unread",
  plot: BARS.plot,
  said: { t: "chart-column-gone", header: "region", name: NAME },
};

afterEach(() => void setLocale(baseLocale, { reload: false }));

test("the caption says the share read while a tally is partial, and the rows once it is complete", () => {
  expect(coverage(tallyOf(READ, ROWS))).toBe("partial · 40% read");
  expect(coverage(tallyOf(ROWS, ROWS))).toBe("4,812 rows");
  expect(coverage(tallyOf(1, 1))).toBe("1 row");
  void setLocale("es", { reload: false });
  expect(coverage(tallyOf(READ, ROWS))).toBe(`parcial · 40${NBSP}% leído`);
  expect(coverage(tallyOf(ROWS, ROWS))).toBe("4812 filas");
});

test("the share read is of the rows the index estimates, which the rows read can run past, and a source of no rows has none", () => {
  expect(coverage(tallyOf(6, 5, false))).toBe("partial · 100% read");
  expect(coverage(tallyOf(0, 0, false))).toBe("partial · 0% read");
});

test("the caption says nothing of the source before a tally, or of one the chart could not read", () => {
  expect(coverage(undefined)).toBe("");
  expect(coverage(UNREAD)).toBe("");
});

/** A complete tally of BARS that left out `blank` cells as blank, and `unparsed` as not numbers. */
function leftOut(blank: number, unparsed = 0): GroupsTally {
  return { ...tallyOf(ROWS, ROWS), skipped: { blank, unparsed } };
}

/** How many cells a tally leaves out here. */
const LEFT_OUT = 1200;

/** What each language says of LEFT_OUT blank cells. */
const BLANK: ReadonlyArray<[Locale, string]> = [
  ["en-US", "1,200 blank"],
  ["en-GB", "1,200 blank"],
  ["es", "1200 en blanco"],
  ["pt-BR", "1.200 em branco"],
  ["pt-PT", "1200 em branco"],
];

test("the caption counts the cells a tally left out as blank, in the language chosen, and says nothing of none", () => {
  for (const [locale, words] of BLANK) {
    void setLocale(locale, { reload: false });
    expect(blank(leftOut(LEFT_OUT)), locale).toBe(words);
    expect(blank(leftOut(0)), locale).toBe("");
  }
  expect(blank(undefined)).toBe("");
  expect(blank(UNREAD)).toBe("");
});

/** What each language says of one cell that was not a number, and of LEFT_OUT. */
const NOT_NUMBERS: ReadonlyArray<[Locale, string, string]> = [
  ["en-US", "1 not a number", "1,200 not numbers"],
  ["en-GB", "1 not a number", "1,200 not numbers"],
  ["es", "1 no es número", "1200 no son números"],
  ["pt-BR", "1 não é número", "1.200 não são números"],
  ["pt-PT", "1 não é número", "1200 não são números"],
];

test("the caption counts the cells that were not numbers, one or more, in the language chosen", () => {
  for (const [locale, one, more] of NOT_NUMBERS) {
    void setLocale(locale, { reload: false });
    expect(notNumbers(leftOut(0, 1)), locale).toBe(one);
    expect(notNumbers(leftOut(0, LEFT_OUT)), locale).toBe(more);
  }
  expect(notNumbers(leftOut(LEFT_OUT))).toBe("");
});

/** What a chart over the export heard with `latest` as its latest tally. */
const heardOf = (latest: Tally | undefined): Heard => ({
  state: "fine",
  name: NAME,
  latest,
  complete: undefined,
});

/** A tally of SCATTER that could place no row. */
const NO_POINTS: SampleTally = {
  t: "sample",
  plot: SCATTER.plot,
  coverage: { rows: ROWS, total: ROWS, complete: true },
  x: [],
  y: [],
  plotted: 0,
  least: { x: 0, y: 0 },
  most: { x: 0, y: 0 },
  skipped: { blank: ROWS, unparsed: 0 },
};

/** A complete tally of BARS with a value in it, which a plot draws. */
const DRAWN = { ...tallyOf(ROWS, ROWS), groups: [{ value: "North", rows: ROWS, sum: 0 }] };

test("the plot says it reads before the first tally, why it cannot read its column, with Edit chart, and that a tally has no values yet, in the language chosen", () => {
  expect(body(BARS.plot, heardOf(undefined))).toStrictEqual({ words: `reading ${NAME}…` });
  const edit = { words: "Edit chart", opens: "form" };
  const gone = { words: `${NAME} has no column called region`, action: edit };
  expect(body(BARS.plot, heardOf(UNREAD))).toStrictEqual(gone);
  expect(body(BARS.plot, heardOf(tallyOf(ROWS, ROWS)))).toStrictEqual({
    words: "no values in region yet",
  });
  expect(body(SCATTER.plot, heardOf(NO_POINTS))).toStrictEqual({
    words: "no values in units, revenue yet",
  });
  // The column that has gone stands against a complete tally of before it went.
  expect(body(BARS.plot, { ...heardOf(UNREAD), complete: DRAWN })).toStrictEqual(gone);
  expect(body(BARS.plot, heardOf(DRAWN))).toBeUndefined();
  void setLocale("es", { reload: false });
  expect(body(BARS.plot, heardOf(undefined))).toStrictEqual({ words: `leyendo ${NAME}…` });
  expect(body(BARS.plot, heardOf(tallyOf(ROWS, ROWS)))).toStrictEqual({
    words: "aún no hay valores en region",
  });
  expect(body(BARS.plot, heardOf(UNREAD))?.action?.words).toBe("Editar gráfico");
});

test("the plot says its source is missing or waits on its bucket, with Re-point or Connect, in the language chosen", () => {
  const missing = { ...heardOf(undefined), state: "missing" } as const;
  const waiting = { ...heardOf(undefined), state: "unconnected", bucket: "open-data" } as const;
  expect(body(BARS.plot, missing)).toStrictEqual({
    words: `${NAME} is missing`,
    action: { words: "Re-point", opens: "panel" },
  });
  expect(body(BARS.plot, waiting)).toStrictEqual({
    words: "open-data is not connected",
    action: { words: "Connect open-data", opens: "panel" },
  });
  void setLocale("es", { reload: false });
  const repoint = { words: "Redirigir", opens: "panel" };
  expect(body(BARS.plot, missing)).toStrictEqual({ words: `falta ${NAME}`, action: repoint });
  expect(body(BARS.plot, waiting)).toStrictEqual({
    words: "open-data no está conectado",
    action: { words: "Conectar open-data", opens: "panel" },
  });
});
