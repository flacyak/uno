/**
 * @fileoverview A .uno dropped on the window over unsaved edits asks first, as
 * Ctrl+O, the sidebar and a file named on the command line do, and dropped
 * again opens. Runs over the real shell and engine, with a host that writes
 * the save to disk so there is a .uno to drop.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { m } from "@paraglide/messages";
import type { Shell } from "@renderer/shell/shell";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The units column of the fixture, where an edit goes. */
const UNITS = 2;

const page = domPage();
let shell: Shell;

const saved = join(mkdtempSync(join(tmpdir(), "uno-drop-")), "books.uno");

function message(): string {
  return document.querySelector("#status-msg")?.textContent ?? "";
}

/** Changes one cell, so the workspace has unsaved edits. */
async function edit(row: number, value: string): Promise<void> {
  await page.clickCell(row, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue(value);
  await page.press("Enter");
  expect(await until(page, () => shell.unsaved)).toBe(true);
}

/** Drops files on the window, as drop.ts reads a drop. */
function drop(...files: File[]): void {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files } });
  document.querySelector("#app")!.dispatchEvent(e);
}

beforeAll(async () => {
  shell = await bootShell({
    pickSave: () => Promise.resolve(saved),
    save: (path, bytes) => writeFile(path, bytes),
    dropped: (file) => ({ name: file.name, path: saved }),
  });
  await page.press("e", { ctrlKey: true });
  await page.settle(2);
  await edit(7, "8");
  await shell.save();
  expect(shell.unsaved).toBe(false);
}, 20_000);

test("a .uno dropped over unsaved edits asks first, and dropped again opens", async () => {
  await edit(8, "9");
  drop(new File([""], "books.uno"));
  await page.settle(2);
  expect(message()).toBe(m.unsaved_edits_open_again());
  expect(shell.unsaved).toBe(true);

  drop(new File([""], "books.uno"));
  expect(await until(page, () => !shell.unsaved)).toBe(true);
});
