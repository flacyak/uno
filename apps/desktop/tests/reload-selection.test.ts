/**
 * @fileoverview A tab reloaded while showing keeps where the grid stands when
 * the answer lands: the selected cell, also one picked during the read, the
 * scroll and the marks. A cell editor open when it lands keeps its text, and
 * nothing typed over the old rows is written to the new ones unasked. The file
 * is as the workspace records it, so the reload leaves the workspace clean.
 * Runs over the real shell and engine.
 *
 * @vitest-environment happy-dom
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { diskProvider } from "@store/node";
import type { Shell } from "@renderer/shell/shell";
import { bootShell, FIXTURE } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** Where the sheet is scrolled during the read, past the harness's 600px screen. */
const SCROLLED = 900;
/** The rows of the fixture's shorter copy, which a reload can answer with. */
const SHORT_ROWS = 3;

const page = domPage();
const disk = diskProvider();
const open = disk.files.open.bind(disk.files);
const opened = vi.spyOn(disk.files, "open");
let shell: Shell;
let short: string;

function cell(): string {
  return document.querySelector("#status-cell")?.textContent ?? "";
}

function message(): string {
  return document.querySelector("#status-msg")?.textContent ?? "";
}

/**
 * Presses r on the tab's line in the panel, with the read held back. Returns
 * a function that lets the read go and waits for the answer.
 */
function reload(path?: string): () => Promise<boolean> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  opened.mockImplementationOnce(async (ref) => {
    await held;
    return open(path === undefined ? ref : { ...ref, path });
  });
  // Cleared, so the wait sees this reload's message and not the last one's.
  document.querySelector("#status-msg")!.textContent = "";
  shell.showPanel();
  document
    .querySelector(".panel-list")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  return () => {
    release();
    return until(page, () => message().startsWith("reloaded"));
  };
}

beforeAll(async () => {
  const header = 1;
  const lines = (await readFile(FIXTURE, "utf8")).split("\n").slice(0, header + SHORT_ROWS);
  short = join(await mkdtemp(join(tmpdir(), "uno-reload-")), "sales-q3.csv");
  await writeFile(short, lines.join("\n") + "\n");
  shell = await bootShell({}, [disk]);
  shell.setInput("vim-style");
}, 20_000);

test("a reload of the showing tab keeps the selected cell, and leaves the workspace clean", async () => {
  await page.clickCell(5, 0);
  expect(await until(page, () => cell().includes("row 6")), cell()).toBe(true);

  // r on the tab's line in the panel reloads it.
  shell.showPanel();
  document
    .querySelector(".panel-list")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  expect(await until(page, () => message().startsWith("reloaded")), message()).toBe(true);

  expect(cell()).toContain("row 6");
  expect(shell.unsaved).toBe(false);
  expect(document.querySelector(".dirty")).toBeNull();
});

test("a reload keeps the selection made during the read, the scroll and the marks", async () => {
  await page.clickCell(3, 0);
  await page.press("m");
  await page.press("a");

  const answered = reload();
  await page.clickCell(7, 1);
  await page.scrollTo(SCROLLED);
  await page.settle(1);
  expect(await answered()).toBe(true);

  expect(cell()).toContain("row 8");
  expect(document.querySelector(".grid-scroll")!.scrollTop).toBe(SCROLLED);
  await page.press("'");
  await page.press("a");
  expect(cell()).toContain("row 4");
});

test("a reload answered while the cell editor is open keeps its text, and writes it on the next commit", async () => {
  // i switches to transform, and then opens the editor.
  await page.press("i");
  const answered = reload(short);
  await page.clickCell(7, 1);
  await page.press("i");
  await page.setEditorValue("typed");
  expect(await answered()).toBe(true);
  expect(await page.editorValue()).toBe("typed");

  // A commit on focus leaving for the page is refused: the shorter file shows
  // under the editor, which keeps the keys, and the next commit writes.
  document.querySelector<HTMLInputElement>(".cell-editor")!.blur();
  expect(document.activeElement?.className).toBe("cell-editor");
  expect(await page.editorValue()).toBe("typed");
  expect(message()).toContain("nothing was written");
  expect(cell()).toContain(`row ${SHORT_ROWS}`);
  expect((await page.rows())[SHORT_ROWS - 1]?.cells[1]).not.toBe("typed");
  await page.press("Enter");
  expect(await page.editorValue()).toBeUndefined();
  expect((await page.rows())[SHORT_ROWS - 1]?.cells[1]).toBe("typed");
});
