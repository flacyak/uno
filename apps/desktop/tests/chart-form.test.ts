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
import { baseLocale, setLocale } from "@paraglide/runtime";
import { ChartForm } from "@renderer/chart/form";
import type { ChartSource, Opening } from "@renderer/chart/form";
import { madeTitle } from "@renderer/chart/window";
import { offered } from "@renderer/language";
import { num } from "@renderer/locale";
import { LABELS } from "@renderer/shell/form";
import { FormulaForm } from "@renderer/shell/formula";

/** The sales export's columns, as the engine reads them. Revenue's numbers are formatted. */
const COLUMNS = [
  { header: "date", kind: "date", flagged: false },
  { header: "region", kind: "text", flagged: false },
  { header: "rep", kind: "text", flagged: false },
  { header: "channel", kind: "text", flagged: false },
  { header: "units", kind: "num", flagged: false },
  { header: "revenue", kind: "text", flagged: true },
] as const;

/** A band of `columns` holding `rows`, cell by cell. */
function banded(
  columns: ChartSource["band"]["columns"],
  rows: ReadonlyArray<readonly string[]> = [],
): ChartSource["band"] {
  return { columns, ready: (row) => row < rows.length, raw: (row, col) => rows[row]?.[col] ?? "" };
}

/** The column selected in the grid: region. */
const REGION = 1;

/** The number columns: units, then revenue, which a sum is of. */
const UNITS = 4;
const REVENUE = 5;

/** The workspace's sources: the sales export, active, then an ads export with
 * its region elsewhere and no revenue, then one whose file is missing, which
 * the engine opens with no columns. */
const SALES = {
  id: "sales",
  name: "sales-q3.csv",
  band: banded(COLUMNS),
  missing: false,
  link: { path: "/exports/sales-q3.csv" },
};
const ADS = {
  id: "ads",
  name: "ads-q3.csv",
  band: banded([COLUMNS[4], COLUMNS[REGION]]),
  missing: false,
  link: { path: "/exports/ads-q3.csv" },
};
const GONE = { id: "gone", name: "ads-q2.csv", band: banded([]), missing: true };
/** Then the sales export's sums, revenue before units, and its takings, revenue beside a cost. */
const SUMS = { ...SALES, id: "sums", band: banded([COLUMNS[REVENUE], COLUMNS[UNITS]]) };
const COST = { header: "cost", kind: "num", flagged: false } as const;
const TAKINGS = { ...SALES, id: "takings", band: banded([COLUMNS[REVENUE], COST]) };
/** Then one that names units twice and region twice, and the second of each. */
const TWINS = {
  ...SALES,
  id: "twins",
  band: banded([COLUMNS[UNITS], COLUMNS[UNITS], COLUMNS[REGION], COLUMNS[REGION]]),
};
const UNITS_TWIN = 1;
const REGION_TWIN = 3;
/** Then the sales export in a bucket, in parts, carried inside the workspace,
 * and in parts the open did not find. */
const OBJECT = { ...SALES, id: "object", link: { path: "s3://acme-exports/sales-q3.csv" } };
const PARTS = { ...SALES, id: "parts", link: undefined, parts: [{ name: "q3-1.csv", path: "" }] };
const CARRIED = { ...SALES, id: "carried", link: undefined };
const LOST = { ...SALES, id: "lost", link: { path: "" } };
/** Then an export of four number columns after a column of names, as parallel coordinates take. */
const DISCOUNT = { header: "discount", kind: "num", flagged: false } as const;
const DAYS = { header: "days", kind: "num", flagged: false } as const;
const MEASURES = {
  ...SALES,
  id: "measures",
  band: banded([COLUMNS[REGION], COLUMNS[UNITS], COLUMNS[REVENUE], DISCOUNT, DAYS]),
};
const SOURCES = [SALES, ADS, GONE, SUMS, TAKINGS, TWINS, OBJECT, PARTS, CARRIED, LOST, MEASURES];

/** What the form asks of the shell to insert `plot` over `source`. */
const inserting = (plot: Plot, title = "", source = SALES.id, refresh = BY_HAND): string =>
  `send ${source} ${JSON.stringify(plot)} ${JSON.stringify(title)} every ${refresh}`;

/** The schedules under an hour the form offers, in minutes between checks. */
const EVERY_FEW_MINUTES = [5, 15, 30];
const QUARTER_HOUR = 15;
/** The Refresh option that shows a number and a unit, and the minutes in an
 * hour, one of those units. Two hours and ninety minutes are on no other
 * option, and a minute is the least Every… takes. */
const EVERY = "every";
const HOUR_MINUTES = 60;
const TWO = 2;
const ONE_MINUTE = 1;
const NINETY_MINUTES = 90;
/** The open form's number of minutes or hours. */
const count = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".count")!;

/** The questions the kind tiles stand under, in the labels' column. */
const QUESTION_WORDS = [
  m.chart_kinds_compare(),
  m.chart_kinds_trend(),
  m.chart_kinds_spread(),
  m.chart_kinds_relate(),
];

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
  new ChartForm({ left: 0, top: 0 }, SOURCES, active, opening, {
    send: (source, plot, title, refresh) => {
      asked.push(inserting(plot, title, source.id, refresh));
      return insert();
    },
    closed: () => asked.push("closed"),
  });
  return { asked, box: document.querySelector<HTMLFormElement>(".chart-form")! };
}

/** The open form's select named `name`, or for "kind" what its tiles hold, as a select would. */
const select = (name: string): HTMLSelectElement =>
  name === "kind"
    ? (tiles() as unknown as HTMLSelectElement)
    : document.querySelector<HTMLSelectElement>(`.chart-form select[name="${name}"]`)!;

/** The open form's kind tiles, as the value chosen and their radios. */
function tiles(): { value: string; options: HTMLInputElement[] } {
  const options = [
    ...document.querySelectorAll<HTMLInputElement>('.chart-form input[name="kind"]'),
  ];
  return { value: options.find((radio) => radio.checked)?.value ?? "", options };
}

/** Chooses `value` in the select named `name`, or the kind tile of `value`, with the keys in it. */
function pick(name: string, value: string): void {
  if (name === "kind") {
    const radio = tiles().options.find((option) => option.value === value)!;
    radio.focus();
    radio.click();
    return;
  }
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

test("it offers bars, a dot plot, a slope, a pie, a chart over time, a week heatmap, a heatmap, a horizon, a histogram, a box plot, a beeswarm, a scatter and parallel coordinates, of three number columns, and opens on bars", () => {
  form();
  const kind = select("kind");
  const offered = [...kind.options].map((o) => [o.parentElement!.textContent, o.disabled]);
  const kinds = [
    m.chart_kind_bars(),
    m.chart_kind_dots(),
    m.chart_kind_slope(),
    m.chart_kind_pie(),
    m.chart_kind_time(),
    m.chart_kind_week(),
    m.chart_kind_heat(),
    m.chart_kind_horizon(),
    m.chart_kind_histogram(),
    m.chart_kind_box(),
    m.chart_kind_swarm(),
    m.chart_kind_scatter(),
    m.chart_kind_parallel(),
  ];
  // The sales export has two number columns, and parallel coordinates take three.
  const parallel = m.chart_kind_parallel();
  expect(offered).toStrictEqual(kinds.map((words) => [words, words === parallel]));
  expect(kind.value).toBe("bars");
});

test("a dot plot asks for By, a number column it is of or none, and a measure, Mean first, once it has one", async () => {
  const { asked, box } = form();
  pick("kind", "dots");
  expect(shown(box)).toStrictEqual([
    m.chart_form_source(),
    ...QUESTION_WORDS,
    m.chart_form_by(),
    m.chart_form_of(),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ]);
  expect(select("dots-of").value).toBe("");
  pick("dots-of", String(REVENUE));
  expect(shown(box)).toContain(m.chart_form_measure());
  expect(select("measure").value).toBe("mean");
  const by = { col: REGION, header: "region" };
  const dots: Plot = { t: "dots", by, of: { col: REVENUE, header: "revenue" }, measure: "mean" };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(dots),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(dots), "closed"]);
});

test("a dot plot's form opens on its columns and measure, and keeps its order", async () => {
  const of = { col: REVENUE, header: "revenue" };
  const by = { col: REGION, header: "region" };
  const plot: Plot = { t: "dots", by, of, measure: "sum", order: ["West"] };
  const { asked } = changing(plot);
  expect(chosen("kind", "by", "dots-of", "measure")).toStrictEqual([
    "dots",
    String(REGION),
    String(REVENUE),
    "sum",
  ]);
  press("Enter");
  await settle();
  expect(asked[0]).toBe(inserting(plot));
});

/** The sales export with a sample of its rows: three channels, web the most common and partner the least. */
const SAMPLED = {
  ...SALES,
  band: banded(
    COLUMNS,
    ["web", "direct", "web", "partner", "direct", "web"].map((channel) => [
      "2025-07-01",
      "North",
      "Ada",
      channel,
      "1",
      "2",
    ]),
  ),
};

test("a slope asks for By, Between, its From and To among Between's most common values, the earlier first, and Of", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: REGION }, SAMPLED);
  pick("kind", "slope");
  // Between opens on the first text column other than By's.
  expect(select("between").value).toBe("2");
  pick("between", String(CHANNEL));
  expect(shown(box)).toStrictEqual([
    m.chart_form_source(),
    ...QUESTION_WORDS,
    m.chart_form_by(),
    m.chart_form_between(),
    m.chart_form_from(),
    m.chart_form_to(),
    m.chart_form_of(),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ]);
  const offered = (name: string) => [...select(name).options].map((o) => o.value);
  expect(offered("from")).toStrictEqual(["web", "direct", "partner"]);
  expect(chosen("from", "to")).toStrictEqual(["direct", "web"]);
  // A slope's states are another column's than its values'.
  const own = [...select("between").options].find((o) => o.value === String(REGION))!;
  expect(own.disabled).toBe(true);
  const by = { col: REGION, header: "region" };
  const plot: Plot = {
    t: "slope",
    by,
    between: { col: CHANNEL, header: "channel" },
    from: "direct",
    to: "web",
  };
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(plot), "closed"]);
});

test("a slope's form opens on its columns, its two states and its measure", () => {
  const plot: Plot = {
    t: "slope",
    by: { col: REGION, header: "region" },
    between: { col: CHANNEL, header: "channel" },
    from: "partner",
    to: "mail",
    of: { col: REVENUE, header: "revenue" },
    measure: "sum",
  };
  changing(plot, "", SAMPLED);
  expect(chosen("kind", "by", "between", "from", "to", "dots-of", "measure")).toStrictEqual([
    "slope",
    String(REGION),
    String(CHANNEL),
    "partner",
    "mail",
    String(REVENUE),
    "sum",
  ]);
});

test("a pie shares out the rows, or a sum, per value of the selected column", async () => {
  const { asked, box } = form();
  pick("kind", "pie");
  pick("sum", String(REVENUE));
  const by = { col: REGION, header: "region" };
  const pie: Plot = { t: "pie", by, sum: { col: REVENUE, header: "revenue" } };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(pie),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(pie), "closed"]);
});

test("a scatter asks for X and Y of the number columns, the first two to begin", async () => {
  const { asked, box } = form();
  pick("kind", "scatter");
  const words = [m.chart_form_source(), ...QUESTION_WORDS, m.chart_form_x(), m.chart_form_y()];
  expect(shown(box)).toStrictEqual([...words, m.chart_form_title_field(), m.chart_form_refresh()]);
  expect([...select("x").options].map((o) => o.textContent)).toStrictEqual(["units", "revenue"]);
  const x = { col: UNITS, header: "units" };
  const scatter: Plot = { t: "scatter", x, y: { col: REVENUE, header: "revenue" } };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(scatter),
  );
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
  expect(tiles().options.find((radio) => radio.value === "scatter")!.disabled).toBe(true);
  expect(shown(box)).toContain(m.chart_form_by());
});

test("an empty title shows the one the chart makes, which follows the column", () => {
  const { box } = form();
  const [by, title] = [select("by"), box.querySelector<HTMLInputElement>('input[type="text"]')!];
  expect(title.placeholder).toBe(madeTitle(REGION_BARS));
  by.value = String(REGION + 1);
  by.dispatchEvent(new Event("change"));
  expect(title.placeholder).toBe(madeTitle({ t: "bars", by: { col: REGION + 1, header: "rep" } }));
});

test("a title of one's own goes in the chart, without the spaces round it", async () => {
  const { asked, box } = form();
  box.querySelector<HTMLInputElement>('input[type="text"]')!.value = "  Orders per region ";
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
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(revenue),
  );
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
  expect(offered).toStrictEqual(SOURCES.map((s) => [s.name, s.missing]));
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

test("a schedule's note says what a check reads of a file, an object or a folder", () => {
  const { box } = form();
  const note = (): string | null => box.querySelector(".note")!.textContent;
  pick("refresh", String(QUARTER_HOUR));
  const name = { name: SALES.name };
  expect(note()).toBe(m.chart_refresh_does_file(name));
  pick("source", String(SOURCES.indexOf(OBJECT)));
  expect(note()).toBe(m.chart_refresh_does_object(name));
  pick("source", String(SOURCES.indexOf(PARTS)));
  expect(note()).toBe(m.chart_refresh_does_folder(name));
  pick("refresh", String(BY_HAND));
  expect(note()).toBe(m.chart_form_hint());
});

test("a carried source, or one whose files the open did not find, turns Refresh off and says why", () => {
  const off = (source: ChartSource): Array<string | boolean | null> => {
    const { box } = form(undefined, { t: "insert", col: REGION }, source);
    return [
      select("refresh").disabled,
      select("refresh").title,
      box.querySelector(".note")!.textContent,
    ];
  };
  const name = { name: SALES.name };
  const carried = [m.chart_refresh_carried(name), m.chart_refresh_note_carried(name)];
  expect(off(CARRIED)).toStrictEqual([true, ...carried]);
  const lost = [m.chart_refresh_lost(name), m.chart_refresh_note_lost(name)];
  expect(off(LOST)).toStrictEqual([true, ...lost]);
  expect(off(SALES)).toStrictEqual([false, "", m.chart_form_hint()]);
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

/** Opens the form to change a chart of `plot` titled `title` over `active`,
 * checked every `refresh` minutes. */
const changing = (
  plot: Plot,
  title = "",
  active: ChartSource = SALES,
  refresh = BY_HAND,
): ReturnType<typeof form> =>
  form(undefined, { t: "change", chart: { plot, title, refresh } }, active);

/** The values of the open form's selects named `names`. */
const chosen = (...names: string[]): string[] => names.map((name) => select(name).value);

test("a chart's form opens on its schedule, and Apply sends the one chosen", async () => {
  const { asked } = changing(REGION_BARS, "", SALES, QUARTER_HOUR);
  expect([chosen("refresh"), count().hidden]).toStrictEqual([[String(QUARTER_HOUR)], true]);
  pick("refresh", String(BY_HAND));
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([regionBars, "closed"]);
});

test("a chart's form opened on its schedule gives the keys to the checks field, or to its first over a source with nothing to read again", () => {
  const opening: Opening = {
    t: "change",
    chart: { plot: REGION_BARS, title: "", refresh: QUARTER_HOUR },
    on: "refresh",
  };
  form(undefined, opening);
  expect(document.activeElement).toBe(select("refresh"));
  form(undefined, opening, LOST);
  expect(document.activeElement).toBe(select("by"));
});

test("a chart's form opens on a schedule it does not offer as Every…, in hours where whole", () => {
  changing(REGION_BARS, "", SALES, NINETY_MINUTES);
  const minutes = [EVERY, String(ONE_MINUTE), String(NINETY_MINUTES)];
  expect([...chosen("refresh", "unit"), count().value]).toStrictEqual(minutes);
  expect(count().hidden).toBe(false);
  changing(REGION_BARS, "", SALES, TWO * HOUR_MINUTES);
  const hours = [EVERY, String(HOUR_MINUTES), String(TWO)];
  expect([...chosen("refresh", "unit"), count().value]).toStrictEqual(hours);
});

test("a chart's form opens on what it shows, over its source", () => {
  const units = { col: UNITS, header: "units" };
  const revenue = { col: REVENUE, header: "revenue" };
  changing({ ...REGION_BARS, sum: revenue }, "Takings");
  expect(chosen("kind", "by", "sum")).toStrictEqual(["bars", String(REGION), String(REVENUE)]);
  expect(document.querySelector<HTMLInputElement>('.chart-form input[type="text"]')!.value).toBe(
    "Takings",
  );
  expect(document.activeElement).toBe(select("by"));

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

test("a source with nothing to read again is checked by hand, whatever was chosen", async () => {
  const { asked } = form();
  pick("refresh", EVERY);
  pick("source", String(SOURCES.indexOf(CARRIED)));
  const off = [chosen("refresh"), count().hidden, count().disabled, select("unit").disabled];
  expect(off).toStrictEqual([[String(BY_HAND)], true, true, true]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(REGION_BARS, "", CARRIED.id), "closed"]);
  const { asked: applied } = changing(REGION_BARS, "", LOST, QUARTER_HOUR);
  expect(chosen("refresh")).toStrictEqual([String(BY_HAND)]);
  press("Enter");
  await settle();
  expect(applied).toStrictEqual([inserting(REGION_BARS, "", LOST.id), "closed"]);
});

/** The formula form's label of its expression, a sign in every language. */
const EQUALS = "=";

test("every worded label of the chart form and the formula form sets the column they share, in every language", () => {
  for (const locale of offered(true)) {
    void setLocale(locale, { reload: false });
    form();
    new FormulaForm({ left: 0, top: 0 }, "q3.csv", [{ header: "price" }], 0, {
      insert: () => Promise.resolve(),
      closed: () => undefined,
    });
    const worded = [...document.querySelectorAll(".what")].map((at) => at.textContent);
    const said = LABELS.map((label) => label());
    expect(worded.filter((label) => label !== EQUALS && !said.includes(label))).toStrictEqual([]);
  }
  void setLocale(baseLocale, { reload: false });
});

/** The sales export's date column, and a Unix column of the times its orders came in. */
const DATE = { col: 0, header: "date" };
const STAMPS = { header: "placed", kind: "num", flagged: false, unit: "s" } as const;
const STAMPED = { ...SALES, id: "stamped", band: banded([...COLUMNS, STAMPS]) };
const PLACED = COLUMNS.length;

test("a date column selected in the grid opens the form on a chart over time of it, asking for its dates, size and sum", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: DATE.col });
  expect(select("kind").value).toBe("time");
  expect(shown(box)).toStrictEqual([
    "source",
    "compare",
    "trend",
    "spread",
    "relate",
    "dates",
    "per",
    "sum of",
    "title",
    "checks",
  ]);
  expect([...select("per").options].map((o) => o.textContent)).toStrictEqual([
    "automatic",
    "hour",
    "day",
    "week",
    "month",
    "quarter",
    "year",
  ]);
  pick("per", "month");
  pick("sum", String(REVENUE));
  press("Enter");
  await settle();
  const sum = { col: REVENUE, header: "revenue" };
  expect(asked).toStrictEqual([
    inserting({ t: "time", at: DATE, per: "month", sum, order: "month" }),
    "closed",
  ]);
});

test("dates whose order the sample left open read as the language reads them, and a Unix column as its unit", async () => {
  await setLocale("en-GB", { reload: false });
  const dated = form(undefined, { t: "insert", col: DATE.col }, STAMPED);
  expect([...select("at").options].map((o) => o.textContent)).toStrictEqual([
    "date",
    "placed (Unix seconds)",
  ]);
  press("Enter");
  await settle();
  const stamped = form(undefined, { t: "insert", col: PLACED }, STAMPED);
  press("Enter");
  await settle();
  await setLocale(baseLocale, { reload: false });
  const placed = { col: PLACED, header: "placed" };
  expect([...dated.asked, ...stamped.asked].filter((a) => a !== "closed")).toStrictEqual([
    inserting({ t: "time", at: DATE, per: "auto", order: "day" }, "", STAMPED.id),
    inserting({ t: "time", at: placed, per: "auto", unit: "s" }, "", STAMPED.id),
  ]);
});

test("a chart over time opened to change keeps its kind, size, sum and the order it reads its dates in", async () => {
  const sum = { col: REVENUE, header: "revenue" };
  const plot: Plot = { t: "time", at: DATE, per: "week", sum, order: "day" };
  const { asked } = form(undefined, { t: "change", chart: { plot, title: "", refresh: BY_HAND } });
  expect([select("kind").value, select("at").value, select("per").value]).toStrictEqual([
    "time",
    "0",
    "week",
  ]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(plot), "closed"]);
});

test("a source with no date column offers no chart over time, no heatmap and no horizon", () => {
  form(undefined, { t: "insert", col: 0 }, ADS);
  const dated = ["time", "week", "heat", "horizon"];
  const off = [...select("kind").options].filter((o) => dated.includes(o.value));
  expect(off.map((o) => o.disabled)).toStrictEqual([true, true, true, true]);
});

test("a week heatmap asks for its dates and a sum, and no size, and makes one that reads its dates as chosen", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: DATE.col });
  pick("kind", "week");
  expect(shown(box)).toStrictEqual([
    "source",
    "compare",
    "trend",
    "spread",
    "relate",
    "dates",
    "sum of",
    "title",
    "checks",
  ]);
  const title = box.querySelector<HTMLInputElement>('input[type="text"]')!;
  expect(title.placeholder).toBe("rows per hour of the week of date");
  pick("sum", String(REVENUE));
  press("Enter");
  await settle();
  const sum = { col: REVENUE, header: "revenue" };
  expect(asked).toStrictEqual([inserting({ t: "week", at: DATE, sum, order: "month" }), "closed"]);
});

test("a week heatmap opened to change keeps its kind, its sum and the order it reads its dates in", async () => {
  const sum = { col: REVENUE, header: "revenue" };
  const plot: Plot = { t: "week", at: DATE, sum, order: "day" };
  const { asked } = form(undefined, { t: "change", chart: { plot, title: "", refresh: BY_HAND } });
  expect([select("kind").value, select("at").value, select("order").value]).toStrictEqual([
    "week",
    "0",
    "day",
  ]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(plot), "closed"]);
});

/** A source of dates written year last, the first of whose cells reads both ways, decided by none or by its sample. */
const WRITTEN = { header: "booked", kind: "date", flagged: false, order: "either" } as const;
const BOOKED = [["03/04/2024"], ["13/04/2024 09:30"]];
const BOOKINGS = { ...SALES, id: "bookings", band: banded([WRITTEN], BOOKED) };
const BOOKED_AT = { col: 0, header: "booked" };

/** The words of each option of the select named `name`, and whether it is off. */
const options = (name: string): Array<[string | null, boolean]> =>
  [...select(name).options].map((o) => [o.textContent, o.disabled]);

test("dates written year last offer their order as a cell of them that reads both ways, the language's chosen where the sample decided none", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: 0 }, BOOKINGS);
  expect(shown(box)).toContain("reads");
  expect(options("order")).toStrictEqual([
    ["03/04/2024: April 3", false],
    ["03/04/2024: March 4", false],
  ]);
  expect(select("order").value).toBe("month");
  pick("order", "day");
  press("Enter");
  await settle();
  expect(asked[0]).toBe(
    inserting({ t: "time", at: BOOKED_AT, per: "auto", order: "day" }, "", BOOKINGS.id),
  );
});

test("the order's words fit the form in each language, day and month named with the cell's year as written", async () => {
  await setLocale("es", { reload: false });
  form(undefined, { t: "insert", col: 0 }, BOOKINGS);
  await setLocale(baseLocale, { reload: false });
  expect(options("order").map(([words]) => words)).toStrictEqual([
    "03/04/2024: 3 abril",
    "03/04/2024: 4 marzo",
  ]);
});

test("a sample that decided its order chooses it, an order no cell shows reads in words, and ISO dates ask none", () => {
  const decided = { ...BOOKINGS, band: banded([{ ...WRITTEN, order: "day" }], [["13/04/2024"]]) };
  form(undefined, { t: "insert", col: 0 }, decided);
  expect(select("order").value).toBe("day");
  expect(options("order").map(([words]) => words)).toStrictEqual(["day first", "month first"]);
  const { box } = form(undefined, { t: "insert", col: 0 });
  expect(shown(box)).not.toContain("reads");
});

test("Hour is offered for a date column that writes a time of day, and not for one of dates alone", () => {
  form(undefined, { t: "insert", col: 0 }, BOOKINGS);
  expect(options("per")[1]).toStrictEqual(["hour", false]);
  form(undefined, { t: "insert", col: 0 }, { ...BOOKINGS, band: banded([WRITTEN], [BOOKED[0]!]) });
  expect(options("per")[1]).toStrictEqual(["hour", true]);
});

test("a chart opened to change keeps the order it reads in, whatever the sample now decides", async () => {
  const plot: Plot = { t: "time", at: BOOKED_AT, per: "day", order: "month" };
  const decided = { ...BOOKINGS, band: banded([{ ...WRITTEN, order: "day" }], BOOKED) };
  const { asked } = form(
    undefined,
    { t: "change", chart: { plot, title: "", refresh: BY_HAND } },
    decided,
  );
  expect(select("order").value).toBe("month");
  press("Enter");
  await settle();
  expect(asked[0]).toBe(inserting(plot, "", BOOKINGS.id));
});

/** The sales export's channel, which splits each region's bar. */
const CHANNEL = 3;

test("picking a split column makes stacked bars, titled by both columns, and none makes bars again", async () => {
  const { asked, box } = form();
  expect(shown(box)).toContain(m.chart_form_split());
  expect(select("split").value).toBe("");
  pick("split", String(CHANNEL));
  pick("sum", String(REVENUE));
  const stack: Plot = {
    t: "stack",
    by: { col: REGION, header: "region" },
    split: { col: CHANNEL, header: "channel" },
    sum: { col: REVENUE, header: "revenue" },
  };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(stack),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(stack), "closed"]);
  // Split back to none, the same choice makes bars.
  form();
  pick("split", String(CHANNEL));
  pick("split", "");
  expect(document.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(REGION_BARS),
  );
});

test("a value splits by any column but its own, and a pie or a scatter asks for no split", () => {
  const { box } = form();
  const own = [...select("split").options].find((o) => o.value === String(REGION))!;
  expect(own.disabled).toBe(true);
  pick("split", String(CHANNEL));
  pick("by", String(CHANNEL));
  expect(select("split").value).toBe("");
  for (const kind of ["pie", "scatter", "time"]) {
    pick("kind", kind);
    expect(shown(box)).not.toContain(m.chart_form_split());
  }
});

test("a stacked chart's form opens on bars of its column, split as it is, and Apply keeps it stacked", async () => {
  const stack: Plot = {
    t: "stack",
    by: { col: REGION, header: "region" },
    split: { col: CHANNEL, header: "channel" },
  };
  const { asked } = changing(stack, "Mix");
  expect(chosen("kind", "by", "split", "sum")).toStrictEqual([
    "bars",
    String(REGION),
    String(CHANNEL),
    "",
  ]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(stack, "Mix"), "closed"]);
});

test("a number column selected in the grid opens the form on a histogram of it, asking for its column alone", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: UNITS });
  expect(select("kind").value).toBe("histogram");
  expect(shown(box)).toStrictEqual([
    m.chart_form_source(),
    ...QUESTION_WORDS,
    m.chart_form_of(),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ]);
  expect(document.activeElement).toBe(select("of"));
  expect([...select("of").options].map((o) => o.textContent)).toStrictEqual(["units", "revenue"]);
  press("Enter");
  await settle();
  const histogram: Plot = { t: "histogram", of: { col: UNITS, header: "units" }, span: "most" };
  expect(asked).toStrictEqual([inserting(histogram), "closed"]);
});

test("a histogram's form opens on its column, and keeps the span it draws", async () => {
  const of = { col: REVENUE, header: "revenue" };
  const { asked } = changing({ t: "histogram", of, span: "all" });
  expect(chosen("kind", "of")).toStrictEqual(["histogram", String(REVENUE)]);
  press("Enter");
  await settle();
  expect(asked[0]).toContain(JSON.stringify({ t: "histogram", of, span: "all" }));
});

test("a box plot asks for the number column it is of and a column to split it by, none or another", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: REVENUE });
  pick("kind", "box");
  expect(shown(box)).toStrictEqual([
    m.chart_form_source(),
    ...QUESTION_WORDS,
    m.chart_form_of(),
    m.chart_form_by(),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ]);
  expect(select("box-by").value).toBe("");
  const own = [...select("box-by").options].find((o) => o.value === String(REVENUE))!;
  expect(own.disabled).toBe(true);
  pick("box-by", String(REGION));
  const of = { col: REVENUE, header: "revenue" };
  const boxPlot: Plot = { t: "box", of, by: { col: REGION, header: "region" }, span: "most" };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(boxPlot),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(boxPlot), "closed"]);
});

test("a box plot's form opens on its columns, and keeps its span", () => {
  const of = { col: REVENUE, header: "revenue" };
  changing({ t: "box", of, by: { col: REGION, header: "region" }, span: "all" });
  expect(chosen("kind", "of", "box-by")).toStrictEqual(["box", String(REVENUE), String(REGION)]);
});

test("a beeswarm asks for the number column it is of and a column of strips, none or another, and opens on its columns", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: REVENUE });
  pick("kind", "swarm");
  expect(shown(box)).toStrictEqual([
    m.chart_form_source(),
    ...QUESTION_WORDS,
    m.chart_form_of(),
    m.chart_form_by(),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ]);
  pick("box-by", String(REGION));
  const of = { col: REVENUE, header: "revenue" };
  const swarmPlot: Plot = { t: "swarm", of, by: { col: REGION, header: "region" } };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(swarmPlot),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(swarmPlot), "closed"]);
  changing(swarmPlot);
  expect(chosen("kind", "of", "box-by")).toStrictEqual(["swarm", String(REVENUE), String(REGION)]);
});

test("a heatmap asks for its dates, a size, its values' column and a sum, and makes one of By's values per period", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: REGION });
  pick("kind", "heat");
  expect(shown(box)).toStrictEqual([
    "source",
    "compare",
    "trend",
    "spread",
    "relate",
    "dates",
    "per",
    "by",
    "sum of",
    "title",
    "checks",
  ]);
  pick("per", "month");
  pick("sum", String(REVENUE));
  press("Enter");
  await settle();
  const sum = { col: REVENUE, header: "revenue" };
  const by = { col: REGION, header: "region" };
  expect(asked).toStrictEqual([
    inserting({ t: "heat", by, at: DATE, sum, per: "month", order: "month" }),
    "closed",
  ]);
});

test("a heatmap opened to change keeps its kind, its values' column, its size and its sum", async () => {
  const sum = { col: REVENUE, header: "revenue" };
  const plot: Plot = {
    t: "heat",
    by: { col: REGION, header: "region" },
    at: DATE,
    sum,
    per: "week",
    order: "day",
  };
  const { asked } = form(undefined, { t: "change", chart: { plot, title: "", refresh: BY_HAND } });
  expect([select("kind").value, select("by").value, select("per").value]).toStrictEqual([
    "heat",
    String(REGION),
    "week",
  ]);
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(plot), "closed"]);
});

test("a horizon asks for its dates, a size, its rows' column or none and a sum, and makes one by the column selected", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: REGION });
  pick("kind", "horizon");
  expect(shown(box)).toStrictEqual([
    "source",
    "compare",
    "trend",
    "spread",
    "relate",
    "dates",
    "per",
    "by",
    "sum of",
    "title",
    "checks",
  ]);
  expect(select("rows-by").options[0]!.textContent).toBe(m.chart_form_rows_none());
  expect(select("rows-by").value).toBe(String(REGION));
  pick("per", "month");
  press("Enter");
  await settle();
  const by = { col: REGION, header: "region" };
  expect(asked).toStrictEqual([
    inserting({ t: "horizon", at: DATE, by, per: "month", order: "month" }),
    "closed",
  ]);
});

test("a horizon of a date column selected draws one series, and one opened to change keeps its kind, its rows' column, its size and its sum", async () => {
  const { asked } = form(undefined, { t: "insert", col: DATE.col });
  pick("kind", "horizon");
  expect(select("rows-by").value).toBe("");
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([
    inserting({ t: "horizon", at: DATE, per: "auto", order: "month" }),
    "closed",
  ]);
  const sum = { col: REVENUE, header: "revenue" };
  const by = { col: REGION, header: "region" };
  const plot: Plot = { t: "horizon", at: DATE, by, sum, per: "week", order: "day" };
  const { asked: changed } = form(undefined, {
    t: "change",
    chart: { plot, title: "", refresh: BY_HAND },
  });
  expect([select("kind").value, select("rows-by").value, select("per").value]).toStrictEqual([
    "horizon",
    String(REGION),
    "week",
  ]);
  press("Enter");
  await settle();
  expect(changed).toStrictEqual([inserting(plot), "closed"]);
});

test("parallel coordinates ask for three to eight number axes in order, the selected one first, each column once, and open on their axes", async () => {
  const { asked, box } = form(undefined, { t: "insert", col: 2 }, MEASURES);
  pick("kind", "parallel");
  const axisWords = (count: number) =>
    Array.from({ length: count }, (_, i) => m.chart_form_axis({ n: num(i + 1) }));
  const fields = (count: number) => [
    m.chart_form_source(),
    ...QUESTION_WORDS,
    ...axisWords(count),
    m.chart_form_title_field(),
    m.chart_form_refresh(),
  ];
  // Revenue, then the number columns after it and before it, and a fourth of none.
  expect(shown(box)).toStrictEqual(fields(4));
  expect(chosen("axis-1", "axis-2", "axis-3", "axis-4")).toStrictEqual(["2", "3", "4", ""]);
  const taken = [...select("axis-2").options].filter((o) => o.disabled).map((o) => o.value);
  expect(taken).toStrictEqual(["2", "4"]);
  pick("axis-4", "1");
  expect(shown(box)).toStrictEqual(fields(5));
  const axes = [2, 3, 4, 1].map((col) => ({ col, header: MEASURES.band.columns[col]!.header }));
  const plot: Plot = { t: "parallel", axes };
  expect(box.querySelector<HTMLInputElement>('input[type="text"]')!.placeholder).toBe(
    madeTitle(plot),
  );
  press("Enter");
  await settle();
  expect(asked).toStrictEqual([inserting(plot, "", MEASURES.id), "closed"]);
  changing(plot, "", MEASURES);
  expect(chosen("kind", "axis-1", "axis-2", "axis-3", "axis-4", "axis-5")).toStrictEqual([
    "parallel",
    "2",
    "3",
    "4",
    "1",
    "",
  ]);
  // An axis of none takes those after it away.
  pick("axis-4", "");
  expect(shown(document.querySelector<HTMLElement>(".chart-form")!)).toStrictEqual(fields(4));
});
