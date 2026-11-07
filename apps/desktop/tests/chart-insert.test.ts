/**
 * @fileoverview Insert chart… through the real shell and engine: a right click
 * on the workspace opens the chart form on the selected column, and Enter makes
 * bars of it, which draw from the real engine in a window that takes the keys.
 * Another insert keeps the windows there, and adds one window however many
 * Enters it takes.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test } from "vite-plus/test";

import { ROWS, counted } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { FIRST_ROWS_MS, bootShell } from "./smoke/dom-harness.ts";
import { domPage, frame, until } from "./smoke/dom-page.ts";

/** The sales export's regions, as its tally sends them, each a quarter of its rows. */
const REGIONS = ["East", "North", "South", "West"];

const page = domPage();

const texts = (selector: string): Array<string | null> =>
  [...document.querySelectorAll(selector)].map((at) => at.textContent);

/** Opens the chart form from the open workspace's menu, and gives its By select. */
async function openForm(): Promise<HTMLSelectElement> {
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.querySelector(".ws.open")!.dispatchEvent(menu);
  await frame();
  const items = [...document.querySelectorAll<HTMLElement>(".pop-item")];
  items.find((item) => item.textContent === m.menu_insert_chart())!.click();
  expect(await until(page, () => document.querySelector(".chart-form") !== null)).toBe(true);
  return document.querySelector<HTMLSelectElement>('.chart-form select[name="by"]')!;
}

/** Presses Enter on `at`, and waits for the form to close. */
async function enter(at: Element, times = 1): Promise<void> {
  const press = { key: "Enter", bubbles: true, cancelable: true };
  for (let i = 0; i < times; i++) at.dispatchEvent(new KeyboardEvent("keydown", press));
  expect(await until(page, () => document.querySelector(".chart-form") === null)).toBe(true);
}

beforeAll(() => bootShell(), FIRST_ROWS_MS);

test("Insert chart… makes bars of the selected column, which draw from the engine", async () => {
  // Select region, the second column.
  await page.press("ArrowRight");
  const by = await openForm();
  expect([by.value, document.activeElement]).toStrictEqual(["1", by]);

  await enter(by);
  const title = m.chart_title_rows({ by: "region" });
  expect(document.querySelector("#status-msg")!.textContent).toBe(m.chart_inserted({ title }));
  expect(document.querySelector<HTMLElement>("#charts")!.hidden).toBe(false);
  expect(document.activeElement).toBe(document.querySelector(".chart"));
  expect(document.querySelector(".ws.open .dirty")).not.toBeNull();
  const quarter = REGIONS.map(() => counted(ROWS / REGIONS.length));
  expect(await until(page, () => texts(".chart-bar-tip").join() === quarter.join())).toBe(true);
  expect(texts(".chart-bar-label")).toStrictEqual(REGIONS);
});

test("another insert keeps the window there, and two Enters add one window", async () => {
  const first = document.querySelector(".chart");
  await enter(await openForm(), 2);
  await frame();
  const windows = [...document.querySelectorAll(".chart")];
  expect(windows.length).toBe(2);
  expect(windows[0]).toBe(first);
  expect(document.activeElement).toBe(windows[1]);
});
