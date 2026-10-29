/**
 * @fileoverview A reopened workspace comes back on the cell each source was
 * left on, and the next save keeps those cells. Runs over the real shell and
 * engine, with a host that writes the save to disk.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { readContainer } from "@document";
import { UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { num } from "@renderer/locale";
import type { Shell } from "@renderer/shell/shell";
import { FIRST_ROWS_MS, FIXTURE, SECOND, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The Clicks column of the second export. */
const CLICKS = 2;
/** Where the fixture is left: row 120, past the first screen, in units. */
const SALES = { row: 119, col: UNITS };
/** Where the second export is left: row 30, in Clicks. */
const ADS = { row: 29, col: CLICKS };

const page = domPage();
let shell: Shell;
const saved = join(mkdtempSync(join(tmpdir(), "uno-reopen-")), "left.uno");

const cell = (): string => document.querySelector("#status-cell")?.textContent ?? "";

/** From column 0, moves to `at` as {row}G then {col}l, and returns the status bar's cell. */
async function go(at: { row: number; col: number }): Promise<string> {
  for (const key of `${at.row + 1}G${at.col}l`) await page.press(key);
  expect(cell()).toContain(m.status_row({ row: num(at.row + 1) }));
  return cell();
}

beforeAll(async () => {
  shell = await bootShell({
    pickSave: () => Promise.resolve(saved),
    save: (path, bytes) => writeFile(path, bytes),
  });
  shell.setInput("vim-style");
}, FIRST_ROWS_MS);

test("a reopened workspace comes back on the cell each source was left on", async () => {
  const sales = await go(SALES);
  await shell.addPaths([SECOND]);
  const ads = await go(ADS);
  document.querySelector<HTMLElement>('.tab[data-source="sales-q3"]')!.click();
  await shell.save();

  await shell.openPath(saved);
  expect(cell()).toBe(sales);
  // The row is drawn on screen too, beside its number.
  const drawn = document.querySelector("td.sel")?.parentElement?.firstElementChild;
  expect(drawn?.textContent).toBe(num(SALES.row + 1));
  document.querySelector<HTMLElement>('.tab[data-source="google-ads-sales"]')!.click();
  expect(cell()).toBe(ads);
});

test("a save after the reopen keeps each source's cell", async () => {
  await shell.save();
  const back = readContainer(basename(saved), await readFile(saved));
  expect(back.sources.map((s) => s.state.active)).toEqual([SALES, ADS]);
});

test("a source whose file has gone keeps its cell, and comes back on it once found", async () => {
  const copy = join(mkdtempSync(join(tmpdir(), "uno-reopen-gone-")), basename(FIXTURE));
  await copyFile(FIXTURE, copy);
  await shell.openPath(copy);
  const sales = await go(SALES);
  await shell.save();

  await rm(copy);
  await shell.openPath(saved);
  await shell.save();
  const back = readContainer(basename(saved), await readFile(saved));
  expect(back.sources.map((s) => s.state.active)).toEqual([SALES]);

  // r on the tab's line in the panel reloads it from the file put back.
  await copyFile(FIXTURE, copy);
  shell.showPanel();
  document
    .querySelector(".panel-list")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  expect(await until(page, () => cell() === sales), cell()).toBe(true);
});
