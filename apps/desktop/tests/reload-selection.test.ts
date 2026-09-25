/**
 * @fileoverview A tab reloaded while showing comes back at the cell that was
 * selected. A tab's cell is saved when it is left, so the showing tab's has to
 * be read off the grid before the tab is replaced. Runs over the real shell
 * and engine.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "@renderer/shell/shell";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;

function cell(): string {
  return document.querySelector("#status-cell")?.textContent ?? "";
}

function message(): string {
  return document.querySelector("#status-msg")?.textContent ?? "";
}

beforeAll(async () => {
  shell = await bootShell();
}, 20_000);

test("a reload of the showing tab keeps the selected cell", async () => {
  await page.clickCell(5, 0);
  expect(await until(page, () => cell().includes("row 6")), cell()).toBe(true);

  // r on the tab's line in the panel reloads it.
  shell.showPanel();
  document
    .querySelector(".panel-list")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  expect(await until(page, () => message().startsWith("reloaded")), message()).toBe(true);

  expect(cell()).toContain("row 6");
});
