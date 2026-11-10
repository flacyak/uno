/**
 * @fileoverview The chart form: what it opens on, what Enter inserts, the
 * schedules it offers, and how Esc, Tab and a refusal behave in it. Opened on
 * a chart, it shows what the chart shows, and Apply sends what it holds.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { BY_HAND, CHARTS_AT_MOST, REFRESH_MINUTES_AT_MOST } from "@document";
import type { Plot } from "@document";
import { Refusal } from "@engine";
import { m } from "@paraglide/messages";
import { ChartForm } from "@renderer/chart/form";
import type { ChartSource, Opening } from "@renderer/chart/form";
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

/** The number columns: units, then revenue, which a sum is of. */
const UNITS = 4;
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
/** Then the sales export's sums, revenue before units, and its takings, revenue beside a cost. */
const SUMS = { ...SALES, id: "sums", band: { columns: [COLUMNS[REVENUE], COLUMNS[UNITS]] } };
const COST = { header: "cost", kind: "num", flagged: false } as const;
const TAKINGS = { ...SALES, id: "takings", band: { columns: [COLUMNS[REVENUE], COST] } };
/** Then one that names units twice and region twice, and the second of each. */
const TWINS = {
  ...SALES,
  id: "twins",
  band: { columns: [COLUMNS[UNITS], COLUMNS[UNITS], COLUMNS[REGION], COLUMNS[REGION]] },
};
const UNITS_TWIN = 1;
const REGION_TWIN = 3;

/** What the form asks of the shell to insert `plot` over `source`. */
const inserting = (plot: Plot, title = "", source = SALES.id, refresh = BY_HAND): string =>
  `send ${source} ${JSON.stringify(plot)} ${JSON.stringify(title)} every ${refresh}`;

/** The schedules under an hour the form offers, in minutes between checks. */
const EVERY_FEW_MINUTES = [5, 15, 30];
const QUARTER_HOUR = 15;
/** The Refresh option that shows a number and a unit, and the minutes in an
 * hour, one of those units. Two hours are on no other option, and a minute is
 * the least Every… takes. */
const EVERY = "every";
const HOUR_MINUTES = 60;
const TWO = 2;
const ONE_MINUTE = 1;
/** The open form's number of minutes or hours. */
const count = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".count")!;

const REGION_BARS: Plot = { t: "bars", by: { col: REGION, header: "region" } };
const regionBars = inserting(REGION_BARS);

/** Opens the form on `opening` over `active`, with `insert` answering each insert. */
function form(
  insert = (): Promise<void> => Promise.resolve(),
  opening: Opening = { t: "insert", col: REGION },
  active: ChartSource = SALES,
): {
  asked: string[];
  box: HTMLFormElement;
} {
  document.body.innerHTML = `<div id="app" tabindex="0"></div>`;
  const asked: string[] = [];
  new ChartForm({ left: 0, top: 0 }, [SALES, ADS, GONE, SUMS, TAKINGS, TWINS], active, opening, {
    send: (source, plot, title, refresh) => {
      asked.push(inserting(plot, title, source.id, refresh));
      return insert();
    },
    closed: () => asked.push("closed"),
  });
  return { asked, box: document.querySelector<HTMLFormElement>(".chart-form")! };
}

/** The open form's select named `name`. */
const select = (name: string): HTMLSelectElement =>
  document.querySelector<HTMLSelectElement>(`.chart-form select[name="${name}"]`)!;

/** Chooses `value` in the select named `name`, with the keys in it. */
function pick(name: string, value: string): void {
  select(name).focus();
  select(name).value = value;
  select(name).dispatchEvent(new Event("change"));
}

/** The labels of the fields that show. */
const shown = (box: HTMLElement): Array<string | null> =>
  [...box.querySelectorAll<HTMLElement>(".field:not([hidden]) .what")].map((at) => at.textContent);

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

test("it offers bars, a pie and a scatter, and opens on bars", () => {
  form();
  const kind = select("kind");
  const offered = [...kind.options].map((o) => [o.textContent, o.disabled]);
  const kinds = [m.chart_kind_bars(), m.chart_kind_pie(), m.chart_kind_scatter()];
  expect(offered).toStrictEqual(kinds.map((words) => [words, false]));
  expect(kind.value).toBe("bars");
});

test("a pie shares out the rows, or a sum, per value of the selected column", async () => {
  const { asked, box } = form();
  pick("kind", "pie");
  pick("sum", String(REVENUE));
  const by = { col: REGION, header: "region" };
  const pie: Plot = { t: "pie", by, sum: { col: REVENUE, header: "revenue" } };
  expect(box.querySelector("input")!.placeholder).toBe(madeTitle(pie));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(pie), "closed"]);
});

test("a scatter asks for X and Y of the number columns, the first two to begin", async () => {
  const { asked, box } = form();
  pick("kind", "scatter");
  const words = [m.chart_form_source(), m.chart_form_kind(), m.chart_form_x(), m.chart_form_y()];
  expect(shown(box)).toStrictEqual([...words, m.chart_form_title_field(), m.chart_form_refresh()]);
  expect([...select("x").options].map((o) => o.textContent)).toStrictEqual(["units", "revenue"]);
  const x = { col: UNITS, header: "units" };
  const scatter: Plot = { t: "scatter", x, y: { col: REVENUE, header: "revenue" } };
  expect(box.querySelector("input")!.placeholder).toBe(madeTitle(scatter));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(scatter), "closed"]);
});

test("a scatter's X starts on the selected column, where it holds numbers", () => {
  form(undefined, { t: "insert", col: REVENUE });
  pick("kind", "scatter");
  expect([select("x").value, select("y").value]).toStrictEqual([String(REVENUE), String(UNITS)]);
});

test("another source keeps a scatter's columns by header, or makes bars under two number columns", () => {
  const { box } = form();
  pick("kind", "scatter");
  pick("source", "3");
  expect([select("x").value, select("y").value]).toStrictEqual(["1", "0"]);
  // Units is gone, so X takes the number column Y leaves.
  pick("source", "4");
  expect([select("x").value, select("y").value]).toStrictEqual(["1", "0"]);
  pick("source", "1");
  expect(select("kind").value).toBe("bars");
  expect(select("kind").options[2]!.disabled).toBe(true);
  expect(shown(box)).toContain(m.chart_form_by());
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
  expect(offered).toStrictEqual(
    [SALES, ADS, GONE, SUMS, TAKINGS, TWINS].map((s) => [s.name, s.missing]),
  );
});

test("Refresh opens by hand, offers every 5, 15 or 30 min, hour or day, and Enter sends it", async () => {
  const { asked } = form();
  expect([...select("refresh").options].map((o) => o.textContent)).toStrictEqual([
    m.chart_refresh_by_hand(),
    ...EVERY_FEW_MINUTES.map((count) => m.chart_refresh_every_minutes({ count: num(count) })),
    m.chart_refresh_every_hour(),
    m.chart_refresh_every_day(),
    m.chart_refresh_every_other(),
  ]);
  expect(select("refresh").value).toBe(String(BY_HAND));
  pick("refresh", String(QUARTER_HOUR));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(REGION_BARS, "", SALES.id, QUARTER_HOUR), "closed"]);
});

test("Every… shows a number and a unit, and Enter sends the minutes they make", async () => {
  const { asked } = form();
  expect([count().hidden, select("unit").hidden]).toStrictEqual([true, true]);
  pick("refresh", EVERY);
  expect([count().hidden, select("unit").hidden]).toStrictEqual([false, false]);
  const units = [m.chart_refresh_unit_minutes(), m.chart_refresh_unit_hours()];
  expect([...select("unit").options].map((o) => o.textContent)).toStrictEqual(units);
  count().value = String(TWO);
  pick("unit", String(HOUR_MINUTES));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(REGION_BARS, "", SALES.id, TWO * HOUR_MINUTES), "closed"]);
});

/** The least gap between a form and the window's edge, as shell/form.ts keeps it. */
const FORM_EDGE = 8;

test("a refusal that makes the form taller hangs it again inside the window", async () => {
  const { box } = form();
  const height = window.innerHeight / 2;
  // The form grows past the window's foot, as a note of two lines makes it.
  box.getBoundingClientRect = () => new DOMRect(0, window.innerHeight - height / 2, 0, height);
  pick("refresh", EVERY);
  press("Enter");
  await settle();
  expect(box.style.top).toBe(`${window.innerHeight - height - FORM_EDGE}px`);
});

test("Every… refuses none, 0, a number that is not whole and more than a week, in the note", async () => {
  const { asked, box } = form();
  pick("refresh", EVERY);
  pick("unit", String(HOUR_MINUTES));
  const week = REFRESH_MINUTES_AT_MOST / HOUR_MINUTES;
  const range = m.chart_refresh_range({ least: num(ONE_MINUTE), most: num(week) });
  const note = box.querySelector(".note")!;
  for (const typed of ["", "0", "1.5", "1e2", String(week + 1)]) {
    count().value = typed;
    press("Enter");
    await settle();
    expect([note.textContent, note.className, document.activeElement]).toStrictEqual([
      range,
      "note err",
      count(),
    ]);
  }
  count().value = String(week);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([
    inserting(REGION_BARS, "", SALES.id, REFRESH_MINUTES_AT_MOST),
    "closed",
  ]);
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

test("Tab passes the fields the kind chosen does not ask for", () => {
  form();
  pick("kind", "scatter");
  expect(press("Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(select("x"));
  pick("kind", "bars");
  press("Tab");
  expect(document.activeElement).toBe(select("by"));
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

/** Opens the form to change a chart of `plot` titled `title` over `active`. */
const changing = (plot: Plot, title = "", active: ChartSource = SALES): ReturnType<typeof form> =>
  form(undefined, { t: "change", chart: { plot, title } }, active);

/** The values of the open form's selects named `names`. */
const chosen = (...names: string[]): string[] => names.map((name) => select(name).value);

test("a chart's form opens on what it shows, over its source", () => {
  const units = { col: UNITS, header: "units" };
  const revenue = { col: REVENUE, header: "revenue" };
  changing({ ...REGION_BARS, sum: revenue }, "Takings");
  expect(chosen("kind", "by", "sum")).toStrictEqual(["bars", String(REGION), String(REVENUE)]);
  expect(document.querySelector<HTMLInputElement>(".chart-form input")!.value).toBe("Takings");
  expect(document.activeElement).toBe(select("by"));
  expect(document.querySelector('select[name="refresh"]')).toBeNull();

  // The ads export has region second.
  changing({ t: "pie", by: { col: REGION, header: "region" } }, "", ADS);
  expect(chosen("source", "kind", "by")).toStrictEqual(["1", "pie", "1"]);
  changing({ t: "scatter", x: revenue, y: units });
  expect(chosen("kind", "x", "y")).toStrictEqual(["scatter", String(REVENUE), String(UNITS)]);
  expect(document.activeElement).toBe(select("x"));
});

test("a chart's form is titled by the chart, and Apply sends what it holds", async () => {
  const { asked, box } = changing(REGION_BARS, "Takings");
  const heading = (): string | null => box.querySelector(".title")!.textContent;
  expect(box.getAttribute("aria-label")).toBe(m.chart_edit());
  expect(heading()).toBe(m.chart_form_title_chart({ title: "Takings" }));
  expect(box.querySelector("button.primary")!.textContent).toBe(m.action_apply());
  expect(box.querySelector(".note")!.textContent).toBe(m.chart_form_hint_change());
  // Another source leaves the title line on the chart, and keeps region, second in it.
  pick("source", "1");
  expect(heading()).toBe(m.chart_form_title_chart({ title: "Takings" }));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(REGION_BARS, "Takings", ADS.id), "closed"]);
});

test("a chart's form opens on the chart's own columns where two share a header", async () => {
  const twinned: Plot = {
    t: "bars",
    by: { col: REGION_TWIN, header: "region" },
    sum: { col: UNITS_TWIN, header: "units" },
  };
  const { asked } = changing(twinned, "", TWINS);
  expect(chosen("by", "sum")).toStrictEqual([String(REGION_TWIN), String(UNITS_TWIN)]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(twinned, "", TWINS.id), "closed"]);
});
