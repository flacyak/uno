// @vitest-environment happy-dom
//
// A key is read once. The grid reads what reaches it first and says so, and
// the shell leaves such a key alone: Ctrl+B pages up under vim-style, and
// did that and closed the sidebar too, since the shell read it again on the
// window. Over the real shell and the real engine, as history.test.ts is.

import { beforeAll, expect, test } from "vite-plus/test";

import { ROWS, counted } from "../src/main/smoke/fixture.ts";
import type { Shell } from "../src/renderer/shell/shell.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage } from "./smoke/dom-page.ts";

/** What the window wears while the sidebar is closed, as shell.ts has it. */
const NO_SIDEBAR = "no-sidebar";
/** Matches dom-page.ts's own budget. */
const TRIES = 150;

const page = domPage();
let shell: Shell;

function sidebarOpen(): boolean {
  return !document.querySelector("#app")!.classList.contains(NO_SIDEBAR);
}

function cell(): string {
  return document.querySelector("#status-cell")?.textContent ?? "";
}

/** until waits, a frame at a time, for `holds` to say so. */
async function until(holds: () => boolean): Promise<boolean> {
  for (let i = 0; i < TRIES && !holds(); i++) await page.settle(2);
  return holds();
}

beforeAll(async () => {
  shell = await bootShell();
}, 20_000);

test("Ctrl+B under vim-style pages up and leaves the sidebar as it is", async () => {
  shell.setInput("vim-style");
  expect(sidebarOpen()).toBe(true);
  // To the end, so there is a page above to go up to.
  await page.press("G");
  const last = `row ${counted(ROWS)}`;
  expect(await until(() => cell().includes(last)), cell()).toBe(true);

  await page.press("b", { ctrlKey: true });
  expect(await until(() => !cell().includes(last)), cell()).toBe(true);
  expect(sidebarOpen()).toBe(true);
});

test("Ctrl+B under the default keys toggles the sidebar", async () => {
  shell.setInput("default");
  await page.press("b", { ctrlKey: true });
  expect(sidebarOpen()).toBe(false);
  await page.press("b", { ctrlKey: true });
  expect(sidebarOpen()).toBe(true);
});
