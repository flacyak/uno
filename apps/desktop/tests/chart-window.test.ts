/**
 * @fileoverview A chart window's words: what a head calls its chart, in any
 * language.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test } from "vite-plus/test";

import type { Chart, Plot } from "@document";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ChartWindow, madeTitle } from "@renderer/chart/window";
import { BARS } from "./charted.ts";

/** The columns the made titles below name. */
const REGION = { col: 1, header: "region" };
const UNITS = { col: 4, header: "units" };
const REVENUE = { col: 5, header: "revenue" };
const BLANK = { col: 2, header: "" };

/** A chart's window, showing `chart`. */
function windowOf(chart: Chart): ChartWindow {
  const made = new ChartWindow();
  made.show(chart);
  document.body.append(made.box);
  return made;
}

function title(box: HTMLElement): HTMLElement {
  return box.querySelector<HTMLElement>(".chart-title")!;
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

test("the head says the title the plot makes, in full on the pointer too", () => {
  const { box } = windowOf(BARS);
  expect(title(box).textContent).toBe(madeTitle(BARS.plot));
  expect(title(box).title).toBe(madeTitle(BARS.plot));
});
