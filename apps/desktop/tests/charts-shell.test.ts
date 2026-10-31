/**
 * @fileoverview A workspace's charts through the real shell and engine.
 * Removing a source warns of its charts first.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import type { CarriedChart, Chart } from "@document";
import { UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import type { Shell } from "@renderer/shell/shell";
import { ADS, BARS, SALES, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, SECOND, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;
const dir = mkdtempSync(join(tmpdir(), "uno-charts-shell-"));

const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const tab = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.tab[data-source="${id}"]`);

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
  shell = await bootShell();
}, FIRST_ROWS_MS);

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
