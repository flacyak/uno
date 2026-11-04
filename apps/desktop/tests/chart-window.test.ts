/**
 * @fileoverview A chart window's words: what a head calls its chart and its
 * source, and what a screen reader is told the window is, in any language.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Chart, Plot } from "@document";
import { m } from "@paraglide/messages";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ChartWindow, madeTitle } from "@renderer/chart/window";
import { BARS } from "./charted.ts";

/** The columns the made titles below name. */
const REGION = { col: 1, header: "region" };
const UNITS = { col: 4, header: "units" };
const REVENUE = { col: 5, header: "revenue" };
const BLANK = { col: 2, header: "" };

/** A chart with a title a person gave it. */
const TITLED: Chart = { ...BARS, title: "Where the rows are" };

/** The name of a source, as a head writes it. */
const SOURCE = "sales-q3";

/** A chart's window, showing `chart` under `source`. */
function windowOf(chart: Chart, source?: string): ChartWindow {
  const made = new ChartWindow();
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

test("a window is a group called a chart, named by its head", () => {
  const { box } = windowOf(BARS);
  expect(box.getAttribute("role")).toBe("group");
  expect(box.getAttribute("aria-roledescription")).toBe(m.chart_role());
  expect(pointedAt(box, "aria-labelledby")).toBe(title(box));
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
  expect(one.getAttribute("aria-labelledby")).not.toBe(two.getAttribute("aria-labelledby"));
});
