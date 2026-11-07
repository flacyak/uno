/**
 * @fileoverview The chart form: what it opens on, what Enter inserts, and how
 * Esc, Tab and a refusal behave in it.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { CHARTS_AT_MOST } from "@document";
import type { Plot } from "@document";
import { Refusal } from "@engine";
import { m } from "@paraglide/messages";
import { ChartForm } from "@renderer/chart/form";
import { madeTitle } from "@renderer/chart/window";
import { num } from "@renderer/locale";

/** The sales export's columns, as the engine reads them. Revenue's numbers are formatted. */
const COLUMNS = [
  { header: "date", kind: "date", flagged: false },
  { header: "region", kind: "text", flagged: false },
  { header: "rep", kind: "text", flagged: false },
  { header: "channel", kind: "text", flagged: false },
  { header: "units", kind: "num", flagged: false },
  { header: "revenue", kind: "text", flagged: true },
] as const;

/** The column selected in the grid: region. */
const REGION = 1;

/** The column a sum is of: revenue. */
const REVENUE = 5;

/** The workspace's sources: the sales export, active, then an ads export with
 * its region elsewhere and no revenue, then one whose file is missing, which
 * the engine opens with no columns. */
const SALES = { id: "sales", name: "sales-q3.csv", band: { columns: COLUMNS }, missing: false };
const ADS = {
  id: "ads",
  name: "ads-q3.csv",
  band: { columns: [COLUMNS[4], COLUMNS[REGION]] },
  missing: false,
};
const GONE = { id: "gone", name: "ads-q2.csv", band: { columns: [] }, missing: true };

/** What the form asks of the shell to insert `plot` over `source`. */
const inserting = (plot: Plot, title = "", source = SALES.id): string =>
  `insert ${source} ${JSON.stringify(plot)} ${JSON.stringify(title)}`;

const REGION_BARS: Plot = { t: "bars", by: { col: REGION, header: "region" } };
const regionBars = inserting(REGION_BARS);

/** Opens the form on region, with `insert` answering each insert. */
function form(insert = (): Promise<void> => Promise.resolve()): {
  asked: string[];
  box: HTMLFormElement;
} {
  document.body.innerHTML = `<div id="app" tabindex="0"></div>`;
  const asked: string[] = [];
  new ChartForm({ left: 0, top: 0 }, [SALES, ADS, GONE], SALES, REGION, {
    insert: (source, plot, title) => {
      asked.push(`insert ${source.id} ${JSON.stringify(plot)} ${JSON.stringify(title)}`);
      return insert();
    },
    closed: () => asked.push("closed"),
  });
  return { asked, box: document.querySelector<HTMLFormElement>(".chart-form")! };
}

/** The open form's select named `name`. */
const select = (name: string): HTMLSelectElement =>
  document.querySelector<HTMLSelectElement>(`.chart-form select[name="${name}"]`)!;

/** Presses `key` where the keys are, and returns the event. */
function press(key: string, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(e);
  return e;
}

/** Lets an insert in flight settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

test("it opens on the selected column, with the keys in it, and says what Enter and Esc do", () => {
  const { box } = form();
  const by = select("by");
  expect(by.value).toBe(String(REGION));
  expect(document.activeElement).toBe(by);
  expect(box.querySelector(".note")!.textContent).toBe(m.chart_form_hint());
});

test("Enter inserts bars of the selected column, and closes", async () => {
  const { asked } = form();
  expect(press("Enter").defaultPrevented).toBe(true);
  await settle();
  expect(asked).toStrictEqual([regionBars, "closed"]);
});

test("it offers bars, a pie and a scatter, and makes bars", () => {
  form();
  const kind = select("kind");
  const offered = [...kind.options].map((o) => [o.textContent, o.disabled]);
  const kinds = [m.chart_kind_bars(), m.chart_kind_pie(), m.chart_kind_scatter()];
  expect(offered).toStrictEqual(kinds.map((words, i) => [words, i > 0]));
  expect(kind.value).toBe("bars");
});

test("an empty title shows the one the chart makes, which follows the column", () => {
  const { box } = form();
  const [by, title] = [select("by"), box.querySelector("input")!];
  expect(title.placeholder).toBe(madeTitle(REGION_BARS));
  by.value = String(REGION + 1);
  by.dispatchEvent(new Event("change"));
  expect(title.placeholder).toBe(madeTitle({ t: "bars", by: { col: REGION + 1, header: "rep" } }));
});

test("a title of one's own goes in the chart, without the spaces round it", async () => {
  const { asked, box } = form();
  box.querySelector("input")!.value = "  Orders per region ";
  box.requestSubmit();
  await settle();
  expect(asked).toStrictEqual([inserting(REGION_BARS, "Orders per region"), "closed"]);
});

test("a sum is of a number column, and is in the title the chart makes", async () => {
  const { asked, box } = form();
  const sum = select("sum");
  const offered = [...sum.options].map((o) => o.textContent);
  expect(offered).toStrictEqual([m.chart_form_sum_none(), "units", "revenue"]);
  expect(sum.value).toBe("");
  sum.value = String(REVENUE);
  sum.dispatchEvent(new Event("change"));
  const revenue: Plot = { ...REGION_BARS, sum: { col: REVENUE, header: "revenue" } };
  expect(box.querySelector("input")!.placeholder).toBe(madeTitle(revenue));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(revenue), "closed"]);
});

test("another source offers its columns, and keeps those it has a header for", async () => {
  const { asked, box } = form();
  select("sum").value = String(REVENUE);
  select("source").value = "1";
  select("source").dispatchEvent(new Event("change"));
  expect(box.querySelector(".title")!.textContent).toBe(
    m.chart_form_title_source({ source: ADS.name }),
  );
  expect([...select("by").options].map((o) => o.textContent)).toStrictEqual(["units", "region"]);
  expect([select("by").value, select("sum").value]).toStrictEqual(["1", ""]);
  select("sum").value = "0";
  press("Enter");
  await settle();
  const units: Plot = {
    t: "bars",
    by: { col: 1, header: "region" },
    sum: { col: 0, header: "units" },
  };
  expect(asked).toStrictEqual([inserting(units, "", ADS.id), "closed"]);
});

test("a source whose file is missing is offered, and cannot be chosen", () => {
  form();
  const offered = [...select("source").options].map((o) => [o.textContent, o.disabled]);
  expect(offered).toStrictEqual([SALES, ADS, GONE].map((s) => [s.name, s.missing]));
});

test("Esc closes it and inserts nothing", () => {
  const { asked } = form();
  press("Escape");
  expect(asked).toStrictEqual(["closed"]);
  expect(document.querySelector(".chart-form")).toBeNull();
});

// The form is at the end of the page, so Tab wraps within it.
test("Tab walks the controls round the ends, and never leaves the form", () => {
  const { box } = form();
  const controls = [...box.querySelectorAll<HTMLElement>("select, input, button")];
  controls[0]!.focus();
  expect(press("Tab", true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls.at(-1));
  expect(press("Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[0]);
});

// Enter on a button is the button's, so the refused chart is asked for once.
test("a refusal stays in the form, on the column chosen", async () => {
  const refused = new Refusal({ t: "charts-at-most", limit: CHARTS_AT_MOST });
  const { asked, box } = form(() => Promise.reject(refused));
  box.querySelector<HTMLElement>("button.primary")!.focus();
  press("Enter");
  box.requestSubmit();
  await settle();
  const note = box.querySelector(".note")!;
  expect(note.className).toBe("note err");
  expect(note.textContent).toBe(m.refused_charts_at_most({ limit: num(CHARTS_AT_MOST) }));
  expect(asked).toStrictEqual([regionBars]);
  expect(document.activeElement).toBe(select("by"));
});
