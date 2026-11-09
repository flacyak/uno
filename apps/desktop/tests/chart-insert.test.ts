/**
 * @fileoverview Insert chart… through the real shell and engine: a right click
 * on the workspace opens the chart form on the selected column, and Enter makes
 * bars of it, which draw from the real engine in a window that takes the keys.
 * Another insert keeps the windows there, and adds one window however many
 * Enters it takes. A pie and a scatter chosen in the form draw too. Ctrl+Shift+G
 * and :chart open the same form. A schedule chosen in it is saved, and the
 * workspace opened again checks the chart's source on it.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { readContainer } from "@document";
import { REGION, ROWS, UNITS, counted } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { Refresher } from "@renderer/refresh";
import type { Shell } from "@renderer/shell/shell";
import { MINUTE_MS } from "@renderer/timing";
import { Workspace } from "@renderer/workspace";
import { FIRST_ROWS_MS, FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, frame, until } from "./smoke/dom-page.ts";

/** The sales export's regions, as its tally sends them, each a quarter of its rows. */
const REGIONS = ["East", "North", "South", "West"];

/** The schedule the form sets: a check every 15 minutes. */
const QUARTER_HOUR = 15;

const page = domPage();
let shell: Shell;
/** Where the first save writes the workspace. */
const saved = join(mkdtempSync(join(tmpdir(), "uno-chart-insert-")), "q3.uno");

const texts = (selector: string): Array<string | null> =>
  [...document.querySelectorAll(selector)].map((at) => at.textContent);

/** Opens the chart form from the open workspace's menu, and gives its By select. */
async function openForm(): Promise<HTMLSelectElement> {
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  document.querySelector(".ws.open")!.dispatchEvent(menu);
  await frame();
  const items = [...document.querySelectorAll<HTMLElement>(".pop-item")];
  const chart = items.find((item) => item.firstChild?.textContent === m.menu_insert_chart())!;
  // The open workspace's item shows the keys that open the form too.
  expect(chart.querySelector(".keys")!.textContent).toBe("Ctrl+Shift+G");
  chart.click();
  return formOpened();
}

/** Waits for the chart form to open, and gives its By select. */
async function formOpened(): Promise<HTMLSelectElement> {
  expect(await until(page, () => document.querySelector(".chart-form") !== null)).toBe(true);
  return document.querySelector<HTMLSelectElement>('.chart-form select[name="by"]')!;
}

/** Presses Enter on `at`, and waits for the form to close. */
async function enter(at: Element, times = 1): Promise<void> {
  const press = { key: "Enter", bubbles: true, cancelable: true };
  for (let i = 0; i < times; i++) at.dispatchEvent(new KeyboardEvent("keydown", press));
  expect(await until(page, () => document.querySelector(".chart-form") === null)).toBe(true);
}

beforeAll(async () => {
  shell = await bootShell({
    pickSave: () => Promise.resolve(saved),
    save: (path, bytes) => writeFile(path, bytes),
  });
}, FIRST_ROWS_MS);

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

test("the form makes a pie of region and a scatter of units, which draw from the engine", async () => {
  const kind = (t: string): HTMLSelectElement => {
    const chosen = document.querySelector<HTMLSelectElement>('.chart-form select[name="kind"]')!;
    chosen.value = t;
    chosen.dispatchEvent(new Event("change"));
    return chosen;
  };
  await openForm();
  await enter(kind("pie"));
  const shares = m.chart_title_share_of_rows({ by: "region" });
  expect(document.querySelector("#status-msg")!.textContent).toBe(
    m.chart_inserted({ title: shares }),
  );
  const slices = (): number => document.querySelectorAll(".chart-pie .chart-slice").length;
  expect(await until(page, () => slices() === REGIONS.length)).toBe(true);

  // The window has the keys, and Escape gives them back to the grid.
  await page.press("Escape");
  for (let col = REGION; col < UNITS; col++) await page.press("ArrowRight");
  await openForm();
  await enter(kind("scatter"));
  const against = m.chart_title_against({ x: "units", y: "revenue" });
  expect(document.querySelector("#status-msg")!.textContent).toBe(
    m.chart_inserted({ title: against }),
  );
  const points = (): number => document.querySelectorAll(".chart-scatter .chart-point").length;
  expect(await until(page, () => points() > 0)).toBe(true);
});

test("Ctrl+Shift+G then Enter on region makes bars of its 4,812 rows", async () => {
  // The scatter's window has the keys, and Escape gives them to the grid on units.
  await page.press("Escape");
  for (let col = UNITS; col > REGION; col--) await page.press("ArrowLeft");
  await page.press("G", { ctrlKey: true, shiftKey: true });
  const by = await formOpened();
  expect([by.value, document.activeElement]).toStrictEqual([String(REGION), by]);
  await enter(by);
  const tips = (): string =>
    [...document.activeElement!.querySelectorAll(".chart-bar-tip")]
      .map((at) => at.textContent)
      .join();
  const quarter = REGIONS.map(() => counted(ROWS / REGIONS.length));
  expect(await until(page, () => tips() === quarter.join())).toBe(true);
});

test(":chart at the vim-style prompt opens the chart form on the selected column", async () => {
  await page.press("Escape");
  shell.setInput("vim-style");
  await page.press(":");
  const cmd = document.querySelector<HTMLInputElement>("#status-cmd")!;
  cmd.value = ":chart";
  cmd.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  const by = await formOpened();
  expect([by.value, document.activeElement]).toStrictEqual([String(REGION), by]);
  by.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  shell.setInput("default");
});

test("a schedule chosen in the form saves, and the workspace opened again checks on it", async () => {
  shell.insertChartHere();
  const by = await formOpened();
  document.querySelector<HTMLSelectElement>('.chart-form select[name="refresh"]')!.value =
    String(QUARTER_HOUR);
  await enter(by);
  await shell.save();
  const scheduled = readContainer(basename(saved), await readFile(saved)).charts?.at(-1);
  expect(scheduled?.refresh).toBe(QUARTER_HOUR);

  const dispose = vi.spyOn(Refresher.prototype, "dispose");
  await shell.openRef({ name: basename(FIXTURE), path: FIXTURE });
  expect(dispose).toHaveBeenCalledOnce();
  const checked = vi.spyOn(Workspace.prototype, "refresh");
  await shell.openRef({ name: basename(saved), path: saved }, saved);
  // The first check comes once the source is indexed, and the next a quarter hour on.
  const first = async (): Promise<boolean> => (await checked.mock.results[0]?.value)?.t === "same";
  await vi.waitUntil(first, { timeout: FIRST_ROWS_MS });
  // The schedule notes when the check ended before the next frame.
  await frame();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + QUARTER_HOUR * MINUTE_MS);
  document.dispatchEvent(new Event("visibilitychange"));
  vi.useRealTimers();
  await vi.waitUntil(() => checked.mock.calls.length === 2);
  expect(checked.mock.calls).toStrictEqual([[scheduled?.source], [scheduled?.source]]);
  dispose.mockRestore();
  checked.mockRestore();
});
