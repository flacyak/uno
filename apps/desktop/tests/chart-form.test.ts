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
import { num } from "@renderer/locale";

/** The sales export's headers. */
const HEADERS = ["date", "region", "rep", "channel", "units", "revenue"];

/** The column selected in the grid: region. */
const REGION = 1;

/** What the form asks of the shell to insert `plot` over the sales export. */
const inserting = (plot: Plot): string => `insert sales ${JSON.stringify(plot)}`;

const regionBars = inserting({ t: "bars", by: { col: REGION, header: "region" } });

/** Opens the form on region, with `insert` answering each insert. */
function form(insert = (): Promise<void> => Promise.resolve()): {
  asked: string[];
  box: HTMLFormElement;
} {
  document.body.innerHTML = `<div id="app" tabindex="0"></div>`;
  const asked: string[] = [];
  const band = { columns: HEADERS.map((header) => ({ header })) };
  new ChartForm({ left: 0, top: 0 }, { id: "sales", name: "sales-q3.csv", band }, REGION, {
    insert: (source, plot) => {
      asked.push(`insert ${source.id} ${JSON.stringify(plot)}`);
      return insert();
    },
    closed: () => asked.push("closed"),
  });
  return { asked, box: document.querySelector<HTMLFormElement>(".chart-form")! };
}

/** Presses `key` where the keys are, and returns the event. */
function press(key: string, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(e);
  return e;
}

/** Lets an insert in flight settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

test("it opens on the selected column, with the keys in it", () => {
  const by = form().box.querySelector("select")!;
  expect(by.value).toBe(String(REGION));
  expect(document.activeElement).toBe(by);
});

test("Enter inserts bars of the selected column, and closes", async () => {
  const { asked } = form();
  expect(press("Enter").defaultPrevented).toBe(true);
  await settle();
  expect(asked).toStrictEqual([regionBars, "closed"]);
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
  expect(document.activeElement).toBe(box.querySelector("select"));
});
