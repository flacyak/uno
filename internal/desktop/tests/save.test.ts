// @vitest-environment happy-dom
//
// Saving from the shell: what is refused before a byte goes to the host, what
// a second Ctrl+S does while the first is still writing, and what the × does
// over a save in flight. Over the real shell and the real engine, as
// history.test.ts is, with a host that answers the dialog and counts writes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { m } from "../src/paraglide/messages.js";
import { RECENTS_KEY } from "../src/renderer/recents.ts";
import type { Shell } from "../src/renderer/shell/shell.ts";
import { FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage } from "./smoke/dom-page.ts";

/** Matches dom-page.ts's own budget. */
const TRIES = 150;
/** The units column of the fixture, where an edit goes. */
const UNITS = 2;

const page = domPage();
let shell: Shell;

const dir = mkdtempSync(join(tmpdir(), "uno-save-"));

/** What the dialog answers next. */
let picked: string | undefined;
/** Every write the host was handed. */
const writes: string[] = [];
/** Lets a write finish, for a test that holds one open. */
let release: (() => void) | undefined;
/** Whether the next write fails, as a full disk would. */
let failing = false;
let quits = 0;

function message(): string {
  return document.querySelector("#status-msg")?.textContent ?? "";
}

function dirtyMarks(): number {
  return document.querySelectorAll(".dirty").length;
}

/** until waits, a frame at a time, for `holds` to say so. */
async function until(holds: () => boolean): Promise<boolean> {
  for (let i = 0; i < TRIES && !holds(); i++) await page.settle(2);
  return holds();
}

/** edit changes one cell, so the workspace has something to save. */
async function edit(row: number, value: string): Promise<void> {
  await page.clickCell(row, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue(value);
  await page.press("Enter");
  expect(await until(() => dirtyMarks() > 0)).toBe(true);
}

beforeAll(async () => {
  shell = await bootShell({
    pickSave: () => Promise.resolve(picked),
    save: (path) => {
      writes.push(path);
      if (failing) return Promise.reject(new Error("ENOSPC: no space left on device"));
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    quit: () => {
      quits++;
    },
  });
  await page.press("e", { ctrlKey: true });
  await page.settle(2);
}, 20_000);

test("Save As cancelled leaves the workspace unsaved, and says nothing", async () => {
  await edit(5, "1101");
  picked = undefined;
  await shell.save();
  expect(writes).toEqual([]);
  expect(message()).toBe("");
  expect(shell.unsaved).toBe(true);
});

test("Save As onto a source of the workspace is refused before anything is written", async () => {
  picked = FIXTURE;
  await shell.saveAs();
  expect(writes).toEqual([]);
  expect(message()).toBe(m.save_over_source({ name: "sales-q3.csv" }));
  expect(shell.unsaved).toBe(true);
  expect(localStorage.getItem(RECENTS_KEY) ?? "[]").not.toContain(FIXTURE);
});

test("a save that fails keeps the dot and says why", async () => {
  picked = join(dir, "sales.uno");
  failing = true;
  await shell.saveAs();
  failing = false;
  expect(writes).toEqual([picked]);
  expect(message()).toContain("ENOSPC");
  expect(shell.unsaved).toBe(true);
  expect(dirtyMarks()).toBeGreaterThan(0);
  writes.length = 0;
});

test("a second Ctrl+S while the first is writing joins it rather than writing twice", async () => {
  const first = shell.save();
  const second = shell.save();
  await page.settle(2);
  expect(writes).toEqual([picked]);
  release?.();
  await Promise.all([first, second]);
  expect(writes).toEqual([picked]);
  expect(shell.unsaved).toBe(false);
  expect(message()).toBe(m.saved_path({ path: picked! }));
  writes.length = 0;
});

test("the × over a save in flight waits for it, and closes once it has landed", async () => {
  await edit(6, "7");
  const saving = shell.save();
  await page.settle(2);
  shell.quit();
  expect(quits).toBe(0);
  release?.();
  await saving;
  expect(await until(() => quits === 1)).toBe(true);
  expect(shell.unsaved).toBe(false);
  writes.length = 0;
});

test("the × over unsaved edits asks first, and a second × goes ahead", async () => {
  await edit(7, "8");
  quits = 0;
  shell.quit();
  expect(quits).toBe(0);
  expect(message()).toBe(m.unsaved_edits_key_again({ key: "×" }));
  shell.quit();
  expect(quits).toBe(1);
});
