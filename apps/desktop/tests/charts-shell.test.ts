/**
 * @fileoverview A workspace's charts through the real shell and engine.
 * Removing a source warns of its charts first, and an open says what it could
 * not show of them. Ctrl+S after a move writes the new place with no mark. Each
 * chart has a window over the sheet for as long as its workspace is the open one,
 * which draws its bars once its tally completes.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeAll, expect, test, vi } from "vite-plus/test";

import { readContainer } from "@document";
import type { CarriedChart, Chart } from "@document";
import { ROWS, UNITS, counted } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { baseLocale } from "@paraglide/runtime";
import { NUDGE_PX, placeOf, placed } from "@renderer/chart/place";
import { madeTitle } from "@renderer/chart/window";
import { num } from "@renderer/locale";
import type { Shell } from "@renderer/shell/shell";
import { ADS, BARS, MOVED, SALES, SHORT_ROWS, holding, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, SECOND, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The digits a save keeps of a place's fractions: core's PLACE_DIGITS. */
const SAVED_DIGITS = 4;

/** A turn of the wheel, in px. */
const WHEELED = 120;

/** The sales export's regions, as its tally sends them, each a quarter of its rows. */
const REGIONS = ["East", "North", "South", "West"];

const page = domPage();
let shell: Shell;
const dir = mkdtempSync(join(tmpdir(), "uno-charts-shell-"));

const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const tab = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.tab[data-source="${id}"]`);
const layer = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const windows = (): number => document.querySelectorAll(".chart").length;
const head = (): string | null | undefined => document.querySelector(".chart-title")?.textContent;
const texts = (selector: string): Array<string | null> =>
  [...document.querySelectorAll(selector)].map((at) => at.textContent);

/** Clicks the × on a source's tab. */
function close(id: string): void {
  tab(id)!.querySelector<HTMLElement>(".close")!.click();
}

/** Writes a .uno holding `charts` and carrying `carried`, opens it, and returns its path. */
async function open(name: string, charts: Chart[], carried?: CarriedChart[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, unoOf(charts, carried));
  await shell.openRef({ name, path });
  return path;
}

beforeAll(async () => {
  shell = await bootShell({ save: (path, bytes) => writeFile(path, bytes) });
}, FIRST_ROWS_MS);

afterEach(() => shell.language.choose(baseLocale));

test("a workspace with no charts leaves the layer hidden", () => {
  expect(document.querySelector<HTMLElement>("#empty")!.hidden).toBe(true);
  expect(layer().hidden).toBe(true);
});

test("a workspace's charts open a window each, and show over every tab", async () => {
  await open("two.uno", [BARS, { ...BARS, id: "c2", source: ADS }]);
  expect(layer().hidden).toBe(false);
  expect(windows()).toBe(2);
  expect(shell.unsaved).toBe(false);

  await page.press("Tab", { ctrlKey: true });
  expect(await until(page, () => tab(ADS)?.classList.contains("active") === true)).toBe(true);
  expect(windows()).toBe(2);
});

test("a chart draws its bars once its tally completes, and again in the language chosen", async () => {
  await open("drawn.uno", [BARS]);
  const quarter = REGIONS.map(() => counted(ROWS / REGIONS.length));
  expect(await until(page, () => texts(".chart-bar-tip").join() === quarter.join())).toBe(true);
  expect(texts(".chart-bar-label")).toStrictEqual(REGIONS);
  expect(texts(".chart-said")).toStrictEqual([m.rows_count({ count: ROWS })]);
  expect(document.querySelector<HTMLElement>(".chart-coverage")!.hidden).toBe(true);

  const plot = document.querySelector<HTMLElement>(".chart-plot")!;
  Object.defineProperty(plot, "clientHeight", { value: holding(SHORT_ROWS) });
  shell.language.choose("es");
  const left = REGIONS.length - (SHORT_ROWS - 1);
  const rows = m.rows_count({ count: (left * ROWS) / REGIONS.length });
  const rest = `${m.chart_bars_more({ count: num(left) })} · ${rows}`;
  expect(await until(page, () => texts(".chart-bars-line").join() === rest)).toBe(true);
});

test("a head names its source only while the workspace has several to tell apart", async () => {
  const title = madeTitle(BARS.plot);
  await open("named.uno", [BARS]);
  expect(head()).toBe(`${SALES} · ${title}`);

  close(ADS);
  expect(await until(page, () => tab(ADS) === null)).toBe(true);
  expect(head()).toBe(title);

  await shell.addPaths([SECOND]);
  expect(head()).toBe(`${SALES} · ${title}`);
});

test("a chart over a missing source says so and offers Re-point, which opens the panel on its source", async () => {
  const path = join(dir, "missing.uno");
  await writeFile(path, unoOf([BARS], [], "/nowhere/sales-q3.csv"));
  await shell.openRef({ name: "missing.uno", path });
  const state = (): string | undefined => document.querySelector(".chart-state")?.textContent;
  expect(await until(page, () => state() !== undefined)).toBe(true);
  const missing = m.chart_source_missing({ name: `${SALES}.csv` });
  expect(state()).toBe(`${missing}${m.action_repoint()}`);
  expect(document.querySelector<HTMLElement>(".chart-coverage")!.hidden).toBe(true);
  document.querySelector<HTMLElement>(".chart-state button")!.click();
  expect(document.querySelector<HTMLElement>("#panel")!.hidden).toBe(false);
});

/**
 * A revenue column with a blank and a word in it, and the row of the word as
 * the status bar counts it.
 */
const AMOUNTS = ["North,10", "South,n/a", "West,", "East,5"];
const WORD_ROW = AMOUNTS.findIndex((row) => row.endsWith("n/a")) + 1;

test("the caption's count of the cells that were not numbers is a button that lands the grid on the first of them", async () => {
  const csv = join(dir, "amounts.csv");
  await writeFile(csv, `region,revenue\n${AMOUNTS.join("\n")}\n`);
  const sum = { col: 1, header: "revenue" };
  const sums: Chart = { ...BARS, plot: { t: "bars", by: { col: 0, header: "region" }, sum } };
  const path = join(dir, "amounts.uno");
  await writeFile(path, unoOf([sums], [], csv));
  await shell.openRef({ name: "amounts.uno", path });
  const find = (): HTMLElement | null => document.querySelector(".chart-find");
  expect(await until(page, () => find()?.hidden === false)).toBe(true);
  const rows = m.rows_count({ count: AMOUNTS.length });
  const left = `${m.chart_blank({ count: num(1) })} · ${m.chart_not_numbers({ count: 1 })}`;
  expect(texts(".chart-said")).toStrictEqual([`${rows} · ${left}`]);

  find()!.click();
  const cell = (): string => document.querySelector("#status-cell")?.textContent ?? "";
  const landed = `${sum.header} · ${m.status_row({ row: num(WORD_ROW) })}`;
  expect(await until(page, () => cell() === landed), cell()).toBe(true);
});

/** The largest double, as a revenue cell writes it. */
const MOST = Number.MAX_VALUE;

/** A revenue column whose North sums past the largest double, and South past its negative. */
const PAST_DOUBLE = [
  `North,${MOST}`,
  `North,${MOST}`,
  `South,-${MOST}`,
  `South,-${MOST}`,
  "East,5",
];

test("a sum past the largest double draws across its side, and the other bars beside it", async () => {
  const csv = join(dir, "huge.csv");
  await writeFile(csv, `region,revenue\n${PAST_DOUBLE.join("\n")}\n`);
  const sum = { col: 1, header: "revenue" };
  const sums: Chart = { ...BARS, plot: { t: "bars", by: { col: 0, header: "region" }, sum } };
  const path = join(dir, "huge.uno");
  await writeFile(path, unoOf([sums], [], csv));
  await shell.openRef({ name: "huge.uno", path });
  const tips = [num(Infinity), num(5), num(-Infinity)];
  expect(await until(page, () => texts(".chart-bar-tip").join() === tips.join())).toBe(true);
  const box = document.querySelector<HTMLElement>(".chart-bars")!;
  const tracks = [...document.querySelectorAll<HTMLElement>(".chart-bar-track")];
  const shares = tracks.map((track) => Number(track.style.getPropertyValue("--share")));
  expect([Number(box.style.getPropertyValue("--zero")), ...shares]).toStrictEqual([
    0.5, 0.5, 0.5, 0.5,
  ]);
});

/** Readings that each stand on a tick, the least 123,456,781 tenths from zero. */
const READINGS = ["12345678.1", "12345678.2", "12345678.3", "12345678.4"];

test("an axis whose ends stand on ticks far from zero runs from the least to the most", async () => {
  const csv = join(dir, "readings.csv");
  await writeFile(csv, `units,reading\n${READINGS.map((at, i) => `${i},${at}`).join("\n")}\n`);
  const readings: Chart = {
    ...BARS,
    plot: { t: "scatter", x: { col: 0, header: "units" }, y: { col: 1, header: "reading" } },
  };
  const path = join(dir, "readings.uno");
  await writeFile(path, unoOf([readings], [], csv));
  await shell.openRef({ name: "readings.uno", path });
  const y = (): Array<string | null> => texts(".chart-ticks.y .chart-tick");
  expect(await until(page, () => y().length > 0)).toBe(true);
  expect(y()).toStrictEqual(["12,345,678.1", "12,345,678.2", "12,345,678.3", "12,345,678.4"]);
});

test("a workspace with none takes the last one's windows away", async () => {
  await open("before.uno", [BARS]);
  await open("none.uno", []);
  expect(windows()).toBe(0);
});

test("an open that fails leaves the windows of the workspace still open", async () => {
  await open("stays.uno", [BARS]);
  await shell.openPath(join(dir, "not-here.uno"));
  expect(windows()).toBe(1);
});

test("an open overtaken by one that fails leaves them too", async () => {
  await open("kept.uno", [BARS]);
  const overtaken = join(dir, "overtaken.uno");
  await writeFile(overtaken, unoOf([BARS, { ...BARS, id: "c2" }]));
  await Promise.all([
    shell.openRef({ name: "overtaken.uno", path: overtaken }),
    shell.openPath(join(dir, "not-here.uno")),
  ]);
  expect(windows()).toBe(1);
});

test("of two opens at once, the windows are the later one's", async () => {
  const early = join(dir, "early.uno");
  const late = join(dir, "late.uno");
  await writeFile(early, unoOf([BARS]));
  await writeFile(late, unoOf([BARS, { ...BARS, id: "c2" }]));
  await Promise.all([
    shell.openRef({ name: "early.uno", path: early }),
    shell.openRef({ name: "late.uno", path: late }),
  ]);
  expect(windows()).toBe(2);
});

test("the first × on a source with charts warns, and the second removes both", async () => {
  await open("warned.uno", [BARS]);
  close(SALES);
  expect(message()).toBe(m.source_takes_charts({ name: basename(FIXTURE) }));
  await page.settle(1);
  expect(tab(SALES)).not.toBeNull();

  close(SALES);
  expect(await until(page, () => tab(SALES) === null)).toBe(true);
  expect(message()).toBe(m.removed_name({ name: basename(FIXTURE) }));
  expect(shell.charts?.all).toStrictEqual([]);
  expect(windows()).toBe(0);
});

test("the first × on a source with charts and edits says both", async () => {
  await open("edited.uno", [BARS]);
  await page.press("e", { ctrlKey: true });
  await page.clickCell(0, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue("8");
  await page.press("Enter");
  expect(await until(page, () => shell.unsaved)).toBe(true);
  close(SALES);
  const charts = m.source_takes_charts({ name: basename(FIXTURE) });
  expect(message()).toBe(`${m.edits_count({ count: 1 })} · ${charts}`);
});

test("the first × on a source whose only charts are carried warns of them", async () => {
  const json = `{"id":"c1","source":"${SALES}","plot":{"t":"line"}}`;
  await open("carrying.uno", [], [{ id: "c1", source: SALES, json }]);
  close(SALES);
  expect(message()).toBe(m.source_takes_charts({ name: basename(FIXTURE) }));
});

test("a source added back has none of the carried charts that left with it", async () => {
  const json = `{"id":"c2","source":"${ADS}","plot":{"t":"line"}}`;
  await open("returned.uno", [BARS], [{ id: "c2", source: ADS, json }]);
  close(ADS);
  close(ADS);
  expect(await until(page, () => tab(ADS) === null)).toBe(true);
  await shell.addPaths([SECOND]);
  close(ADS);
  expect(await until(page, () => tab(ADS) === null)).toBe(true);
});

test("a source with no charts goes on the first ×", async () => {
  await open("bare.uno", [BARS]);
  close(ADS);
  expect(await until(page, () => tab(ADS) === null)).toBe(true);
  expect(message()).toBe(m.removed_name({ name: basename(SECOND) }));
});

test("an open says what it could not show of a .uno's charts, once", async () => {
  const carried = { id: "c2", source: SALES, json: '{"id":"c2","plot":{"t":"line"}}' };
  await open("carried.uno", [BARS], [carried]);
  expect(message()).toBe(m.charts_kept({ count: 1 }));

  await open("whole.uno", [BARS]);
  expect(message()).toBe("");
});

// The record is a later build's, so its window says so where it stood, and
// lets the pointer through to the sheet.
test("a chart this build cannot draw keeps its window at its place, saying a newer uno made it", async () => {
  const room = { w: 1000, h: 600 };
  const measured = vi.spyOn(layer(), "getBoundingClientRect");
  measured.mockReturnValue(new DOMRect(0, 0, room.w, room.h));
  const json = JSON.stringify({ ...BARS, id: "c2", plot: { t: "unknown" }, place: MOVED });
  await open("unknown.uno", [BARS], [{ id: "c2", source: SALES, json }]);
  const box = document.querySelector<HTMLElement>(".chart-carried");
  measured.mockRestore();

  expect(box).not.toBeNull();
  const at = placed(MOVED, room);
  const stood = [box!.style.left, box!.style.top, box!.style.width, box!.style.height];
  expect(stood).toEqual([at.x, at.y, at.width, at.height].map((px) => `${px}px`));
  expect(box!.textContent).toBe(m.chart_carried());
  expect(windows()).toBe(2);
});

test("Ctrl+S after a move writes the new place, with no unsaved mark", async () => {
  const path = await open("moved.uno", [BARS]);
  shell.charts?.move(BARS.id, MOVED);
  expect(shell.unsaved).toBe(false);
  // Ctrl+S is the menu's accelerator, which calls this.
  await shell.save();
  expect(message()).toBe(m.saved_path({ path }));
  const back = readContainer(basename(path), await readFile(path));
  expect(back.charts).toStrictEqual([{ ...BARS, place: MOVED }]);
  expect(document.querySelector(".ws.open .dirty")).toBeNull();
});

test("an arrow on a window moves it with no unsaved mark, and a save writes the place", async () => {
  const path = await open("nudged.uno", [BARS]);
  const room = { w: 1000, h: 600 };
  vi.spyOn(layer(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, room.w, room.h));
  const at = placed(BARS.place, room);
  const box = document.querySelector<HTMLElement>(".chart")!;
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(shell.unsaved).toBe(false);

  await shell.save();
  const back = readContainer(basename(path), await readFile(path));
  const { x } = placeOf({ ...at, x: at.x - NUDGE_PX }, room, BARS.place);
  expect(back.charts?.[0]?.place.x).toBeCloseTo(x, SAVED_DIGITS);
  expect(document.querySelector(".ws.open .dirty")).toBeNull();
});

test("Escape on a window gives the keys back to the grid", async () => {
  await open("left.uno", [BARS]);
  const box = document.querySelector<HTMLElement>(".chart")!;
  box.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.activeElement).toBe(document.querySelector("#content"));
});

test("a wheel on a window scrolls the sheet behind it, and marks nothing", async () => {
  await open("wheeled.uno", [BARS]);
  const sheet = document.querySelector<HTMLElement>(".grid-scroll")!;
  const plot = document.querySelector<HTMLElement>(".chart-plot")!;
  sheet.scrollTop = 0;

  plot.dispatchEvent(new WheelEvent("wheel", { deltaY: WHEELED, bubbles: true, cancelable: true }));

  expect(sheet.scrollTop).toBe(WHEELED);
  expect(document.querySelector(".ws.open .dirty")).toBeNull();
});

test("a chart change stays unsaved through a save the host cannot write", async () => {
  const path = await open("refused.uno", [BARS]);
  await shell.charts?.change(BARS.id, { title: "Rows" });
  await rm(path);
  await mkdir(path);
  await shell.save();
  expect(message()).toContain("EISDIR");
  expect(shell.unsaved).toBe(true);
});
