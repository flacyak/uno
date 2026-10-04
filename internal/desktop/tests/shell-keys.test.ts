// @vitest-environment happy-dom
//
// A key is read once. When the grid handles a key, the shell leaves it
// alone: Ctrl+B pages up under vim-style and the sidebar stays as it was.
// Runs over the real shell and engine.

import { beforeAll, expect, test } from "vite-plus/test";

import { ROWS, counted } from "../src/main/smoke/fixture.ts";
import type { Shell } from "../src/renderer/shell/shell.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The class on the window while the sidebar is closed, as shell.ts sets it. */
const NO_SIDEBAR = "no-sidebar";

const page = domPage();
let shell: Shell;

function sidebarOpen(): boolean {
  return !document.querySelector("#app")!.classList.contains(NO_SIDEBAR);
}

function cell(): string {
  return document.querySelector("#status-cell")?.textContent ?? "";
}

beforeAll(async () => {
  shell = await bootShell();
}, 20_000);

test("Ctrl+B under vim-style pages up and leaves the sidebar as it is", async () => {
  shell.setInput("vim-style");
  expect(sidebarOpen()).toBe(true);
  // Go to the end, so there is a page above to go up to.
  await page.press("G");
  const last = `row ${counted(ROWS)}`;
  expect(await until(page, () => cell().includes(last)), cell()).toBe(true);

  await page.press("b", { ctrlKey: true });
  expect(await until(page, () => !cell().includes(last)), cell()).toBe(true);
  expect(sidebarOpen()).toBe(true);
});

test("Ctrl+B under the default keys toggles the sidebar", async () => {
  shell.setInput("default");
  await page.press("b", { ctrlKey: true });
  expect(sidebarOpen()).toBe(false);
  await page.press("b", { ctrlKey: true });
  expect(sidebarOpen()).toBe(true);
});
