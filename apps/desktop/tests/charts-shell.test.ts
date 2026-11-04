/**
 * @fileoverview A workspace's charts through the real shell and engine.
 * Removing a source warns of its charts first, and an open says what it could
 * not show of them. Ctrl+S after a move writes the new place with no mark. Each
 * chart has a window over the sheet for as long as its workspace is the open one.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { readContainer } from "@document";
import type { CarriedChart, Chart } from "@document";
import { UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { madeTitle } from "@renderer/chart/window";
import type { Shell } from "@renderer/shell/shell";
import { ADS, BARS, MOVED, SALES, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, SECOND, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;
const dir = mkdtempSync(join(tmpdir(), "uno-charts-shell-"));

const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const tab = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.tab[data-source="${id}"]`);
const layer = (): HTMLElement => document.querySelector<HTMLElement>("#charts")!;
const windows = (): number => document.querySelectorAll(".chart").length;
const head = (): string | null | undefined => document.querySelector(".chart-title")?.textContent;

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

test("a chart change stays unsaved through a save the host cannot write", async () => {
  const path = await open("refused.uno", [BARS]);
  await shell.charts?.change(BARS.id, { title: "Rows" });
  await rm(path);
  await mkdir(path);
  await shell.save();
  expect(message()).toContain("EISDIR");
  expect(shell.unsaved).toBe(true);
});
