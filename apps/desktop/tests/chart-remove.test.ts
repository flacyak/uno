/**
 * @fileoverview A chart removed from its own window, through the real shell
 * and engine: the first × or Delete arms the × and says what the second does,
 * which removes the chart, gives the grid the keys and marks the workspace
 * unsaved. Any other message disarms it.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { m } from "@paraglide/messages";
import { madeTitle } from "@renderer/chart/window";
import type { Shell } from "@renderer/shell/shell";
import { BARS, PIE, SALES, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;

const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];
const cross = (box: HTMLElement): HTMLElement => box.querySelector<HTMLElement>(".chart-close")!;
const dotted = (): boolean => document.querySelector(".ws.open .dirty") !== null;
const del = (held: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true, ...held });

beforeAll(async () => {
  shell = await bootShell();
  const path = join(mkdtempSync(join(tmpdir(), "uno-chart-remove-")), "q3.uno");
  await writeFile(path, unoOf([BARS, PIE]));
  await shell.openRef({ name: "q3.uno", path });
}, FIRST_ROWS_MS);

test("the first × arms it and says so, and the second removes the chart and sets the dot", async () => {
  const [bars, pie] = windows();
  cross(bars!).click();
  expect(cross(bars!).classList.contains("armed")).toBe(true);
  expect(message()).toBe(m.chart_remove_armed({ title: madeTitle(BARS.plot) }));
  expect([windows().length, dotted()]).toStrictEqual([2, false]);

  cross(bars!).click();
  expect(windows()).toStrictEqual([pie]);
  expect(document.activeElement?.closest("#content")).not.toBeNull();
  const removed = m.removed_name({ name: madeTitle(BARS.plot) });
  expect(await until(page, () => dotted() && message() === removed)).toBe(true);
});

test("Delete arms the same, another message disarms it, and the next two remove the chart", async () => {
  const [pie] = windows();
  pie!.dispatchEvent(del());
  expect(message()).toBe(m.chart_remove_armed({ title: madeTitle(PIE.plot) }));
  // A held Delete, or one with a modifier, removes nothing.
  pie!.dispatchEvent(del({ repeat: true }));
  pie!.dispatchEvent(del({ ctrlKey: true }));
  expect(windows()).toStrictEqual([pie]);
  // The source's × says it takes its charts with it.
  document.querySelector<HTMLElement>(`.tab[data-source="${SALES}"] .close`)!.click();
  expect(cross(pie!).classList.contains("armed")).toBe(false);
  pie!.dispatchEvent(del());
  expect(windows()).toStrictEqual([pie]);
  pie!.dispatchEvent(del());
  expect(windows()).toStrictEqual([]);
});
