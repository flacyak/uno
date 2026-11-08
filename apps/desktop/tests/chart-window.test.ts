/**
 * @fileoverview A chart window's words: what a head calls its chart and its
 * source, what a screen reader is told the window is, and what its drawing
 * says it shows, in any language.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Chart, Plot } from "@document";
import type { GroupsTally } from "@engine";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { summary } from "@renderer/chart/summary";
import { ChartWindow, madeTitle } from "@renderer/chart/window";
import type { Stage } from "@renderer/chart/window";
import type { Heard } from "@renderer/charts";
import { BARS } from "./charted.ts";
import { frame } from "./smoke/dom-page.ts";

/** The columns the made titles below name. */
const REGION = { col: 1, header: "region" };
const UNITS = { col: 4, header: "units" };
const REVENUE = { col: 5, header: "revenue" };
const BLANK = { col: 2, header: "" };

/** A chart with a title a person gave it. */
const TITLED: Chart = { ...BARS, title: "Where the rows are" };

/** The name of a source, as a head writes it. */
const SOURCE = "sales-q3";

/** A layer for a window whose words are all a test reads. */
const NO_LAYER: Stage = {
  room: () => ({ w: 0, h: 0 }),
  move: () => undefined,
  draw: () => undefined,
  raise: () => undefined,
  leave: () => undefined,
  wheelBy: () => undefined,
  heard: () => undefined,
  repoint: () => undefined,
  notNumbers: () => undefined,
};

/** A chart's window, showing `chart` under `source`. */
function windowOf(chart: Chart, source?: string): ChartWindow {
  const made = new ChartWindow(chart, NO_LAYER);
  made.show(chart, source);
  document.body.append(made.box);
  return made;
}

/** The element an attribute of `box` points at. */
function pointedAt(box: HTMLElement, attribute: string): Element {
  return document.getElementById(box.getAttribute(attribute) ?? "")!;
}

function title(box: HTMLElement): HTMLElement {
  return box.querySelector<HTMLElement>(".chart-title")!;
}

function close(box: HTMLElement): HTMLButtonElement {
  return box.querySelector<HTMLButtonElement>(".round-x")!;
}

afterEach(() => {
  void setLocale(baseLocale, { reload: false });
  document.body.replaceChildren();
});

test.each<[string, string, Plot]>([
  ["Rows per region", "Filas por region", { t: "bars", by: REGION }],
  [
    "Sum of revenue per region",
    "Suma de revenue por region",
    { t: "bars", by: REGION, sum: REVENUE },
  ],
  ["Share of rows per region", "Proporción de filas por region", { t: "pie", by: REGION }],
  [
    "Share of revenue per region",
    "Proporción de revenue por region",
    { t: "pie", by: REGION, sum: REVENUE },
  ],
  ["revenue against units", "revenue frente a units", { t: "scatter", x: UNITS, y: REVENUE }],
  ["Rows per column 3", "Filas por columna 3", { t: "bars", by: BLANK }],
  ["column 3 against units", "columna 3 frente a units", { t: "scatter", x: UNITS, y: BLANK }],
])("a plot makes the title %s in the app's language, from its columns", (en, es, plot) => {
  expect(madeTitle(plot)).toBe(en);
  void setLocale("es", { reload: false });
  expect(madeTitle(plot)).toBe(es);
});

test("a window is a group called a chart, named by its head and described by its caption", () => {
  const { box } = windowOf(BARS);
  expect(box.getAttribute("role")).toBe("group");
  expect(box.getAttribute("aria-roledescription")).toBe(m.chart_role());
  expect(pointedAt(box, "aria-labelledby")).toBe(title(box));
  expect(pointedAt(box, "aria-describedby")).toBe(box.querySelector(".chart-caption"));
});

test("a click can focus a window, and Tab passes it by", () => {
  expect(windowOf(BARS).box.getAttribute("tabindex")).toBe("-1");
});

test("the head says the title the plot makes, in full on the pointer too", () => {
  const { box } = windowOf(BARS);
  expect(title(box).textContent).toBe(madeTitle(BARS.plot));
  expect(title(box).title).toBe(madeTitle(BARS.plot));
  expect(title(box).classList.contains("from-file")).toBe(false);
});

test("a person's title takes the made one's place, and is marked as the file's", () => {
  const { box } = windowOf(TITLED);
  expect(title(box).textContent).toBe(TITLED.title);
  expect(title(box).title).toBe(TITLED.title);
  expect(title(box).classList.contains("from-file")).toBe(true);
});

test("a head with a source to name says it first, marked as the file's", () => {
  const { box } = windowOf(BARS, SOURCE);
  const named = `${SOURCE} · ${madeTitle(BARS.plot)}`;
  expect(title(box).textContent).toBe(named);
  expect(title(box).title).toBe(named);
  expect(title(box).querySelector(".from-file")?.textContent).toBe(SOURCE);
});

test("a window shown again says what its chart says now, and keeps the ×", () => {
  const made = windowOf(BARS, SOURCE);
  const x = close(made.box);

  made.show(TITLED, undefined);
  expect(title(made.box).textContent).toBe(TITLED.title);
  expect(close(made.box)).toBe(x);

  made.show(BARS, undefined);
  expect(title(made.box).classList.contains("from-file")).toBe(false);
});

test("the × is a named button of the window's own kind, and submits nothing", () => {
  const x = close(windowOf(BARS).box);
  expect(x.type).toBe("button");
  expect(x.getAttribute("aria-label")).toBe(m.chart_remove_aria());
  expect(x.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("relabel writes the window's own words in the language chosen since", () => {
  const made = windowOf(BARS);
  void setLocale("es", { reload: false });
  made.relabel();
  expect(made.box.getAttribute("aria-roledescription")).toBe(m.chart_role());
  expect(close(made.box).getAttribute("aria-label")).toBe(m.chart_remove_aria());
  expect(m.chart_role()).not.toBe(m.chart_role({}, { locale: baseLocale }));
});

test("each window has ids of its own, whatever its chart's id holds", () => {
  const spaced = { ...BARS, id: "two words" };
  const [one, two] = [windowOf(spaced).box, windowOf(spaced).box];
  expect(pointedAt(one, "aria-labelledby")).toBe(title(one));
  expect(pointedAt(two, "aria-labelledby")).toBe(title(two));
  expect(pointedAt(two, "aria-describedby")).toBe(two.querySelector(".chart-caption"));
  expect(one.getAttribute("aria-labelledby")).not.toBe(two.getAttribute("aria-labelledby"));
});

test("the head, the track and the caption are drawn, with a grip that says nothing", () => {
  const { box } = windowOf(BARS);
  expect([...box.children].map((child) => child.className)).toStrictEqual([
    "col-head chart-head",
    "chart-plot",
    "chart-summary",
    "chart-coverage",
    "chart-caption",
    "chart-edge chart-edge-right",
    "chart-edge chart-edge-foot",
  ]);
  expect(box.querySelector(".chart-caption .chart-grip")?.getAttribute("aria-hidden")).toBe("true");
});

test("a repaint that takes what held the keys out of the plot gives them to the window", async () => {
  const missing: Heard = { state: "missing", name: SOURCE, latest: undefined, complete: undefined };
  const made = new ChartWindow(BARS, { ...NO_LAYER, heard: () => missing });
  made.show(BARS, undefined);
  document.body.append(made.box);
  await frame();
  const repoint = made.box.querySelector<HTMLButtonElement>(".chart-state button")!;
  repoint.focus();
  expect(document.activeElement).toBe(repoint);
  made.redraw();
  await frame();
  expect(made.box.querySelector(".chart-state button")).not.toBe(repoint);
  expect(document.activeElement).toBe(made.box);
});

/** The sales export's file, as a window hears its source named. */
const NAME = "sales-q3.csv";

/** A tally of BARS with a row of each of `values`, complete or still read. */
function tallyOf(values: string[], complete: boolean): GroupsTally {
  const none = { values: 0, rows: 0, sum: 0 };
  return {
    t: "groups",
    plot: BARS.plot,
    coverage: { rows: values.length, total: values.length, complete },
    groups: values.map((value) => ({ value, rows: 1, sum: 0 })),
    others: none,
    below: none,
    rest: none,
    skipped: { blank: 0, unparsed: 0 },
  };
}

/** What BARS's chart heard: `latest`, and `complete` as the last complete tally. */
const heardOf = (latest: GroupsTally, complete: GroupsTally | undefined): Heard => ({
  state: "fine",
  name: NAME,
  latest,
  complete,
});

/** A window of `chart`, whose chart hears what `heard` says by each draw, over a stage of `more`. */
function hearing(heard: () => Heard, chart = BARS, more: Partial<Stage> = {}): ChartWindow {
  const made = new ChartWindow(chart, { ...NO_LAYER, heard, ...more });
  made.show(chart, undefined);
  document.body.append(made.box);
  return made;
}

const image = (box: HTMLElement): HTMLElement => box.querySelector<HTMLElement>('[role="img"]')!;
const told = (box: HTMLElement): string => box.querySelector(".chart-summary")?.textContent ?? "";

test("the drawing is an image named by the head until a tally completes, then by what the chart says it shows, which a partial never changes", async () => {
  const read = tallyOf(["North", "South"], true);
  let heard = heardOf(tallyOf(["North"], false), undefined);
  const made = hearing(() => heard);
  await frame();
  expect(image(made.box).classList.contains("chart-bars")).toBe(true);
  expect(pointedAt(image(made.box), "aria-labelledby")).toBe(title(made.box));
  expect(told(made.box).trim()).toBe("");

  heard = heardOf(read, read);
  made.redraw();
  await frame();
  const { said, values, more } = summary(madeTitle(BARS.plot), NAME, BARS.plot, read);
  expect(pointedAt(image(made.box), "aria-labelledby")).toBe(
    made.box.querySelector(".chart-summary"),
  );
  expect(told(made.box)).toBe(`${said} ${values} ${more}`);
  expect(made.box.querySelector(".chart-summary .from-file")?.textContent).toBe(values);

  heard = heardOf(tallyOf(["North", "South", "West"], false), read);
  made.redraw();
  await frame();
  expect(told(made.box)).toBe(`${said} ${values} ${more}`);
});

test("a relabel writes the summary in the language chosen since, out of sight", async () => {
  const read = tallyOf(["North", "South"], true);
  const made = hearing(() => heardOf(read, read));
  await frame();
  void setLocale("es", { reload: false });
  made.relabel();
  await frame();
  const { said } = summary(madeTitle(BARS.plot), NAME, BARS.plot, read);
  expect(said).toContain("Filas");
  expect(made.box.querySelector(".chart-summary-said")?.textContent).toBe(said);
  expect(made.box.querySelector<HTMLElement>(".chart-summary")?.hidden).toBe(true);
});
