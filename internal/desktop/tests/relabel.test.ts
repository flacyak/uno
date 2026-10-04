// @vitest-environment happy-dom
//
// Changing the language redraws the window. Runs over the real shell and
// engine: the edit, the selection, the scroll, the mark, and the undo history
// survive the change, the counts are grouped the new language's way, and two
// changes in a row leave one of everything.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { ROWS } from "../src/main/smoke/fixture.ts";
import { m } from "../src/paraglide/messages.js";
import { getLocale } from "../src/paraglide/runtime.js";
import { num } from "../src/renderer/locale.ts";
import type { Shell } from "../src/renderer/shell/shell.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The units column of the fixture, where an edit goes. */
const UNITS = 2;
/** A row the mark is set on, and one the selection is left on. */
const MARKED_ROW = 2;
const LEFT_ROW = 5;
/** Far enough down that the gutter shows a grouped number. */
const DEEP_SCROLL_PX = 29 * 1200;

const page = domPage();
let shell: Shell;

const dir = mkdtempSync(join(tmpdir(), "uno-relabel-"));
/** Resolves the save in flight. */
let release: (() => void) | undefined;

function message(): string {
  return document.querySelector("#status-msg")?.textContent ?? "";
}

function fileLine(): string {
  return document.querySelector("#status-file")?.textContent ?? "";
}

function cellLine(): string {
  return document.querySelector("#status-cell")?.textContent ?? "";
}

function sidebarHidden(): boolean {
  return document.querySelector("#app")?.classList.contains("no-sidebar") ?? false;
}

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>(".grid-scroll")!;
}

async function edit(row: number, value: string): Promise<void> {
  // Scroll to the top first, so the row clicked is counted from the top of
  // the file.
  await page.scrollTo(0);
  await page.settle(2);
  await page.clickCell(row, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue(value);
  await page.press("Enter");
  expect(await until(page, () => document.querySelectorAll(".dirty").length > 0)).toBe(true);
}

beforeAll(async () => {
  shell = await bootShell({
    pickSave: () => Promise.resolve(join(dir, "kept.uno")),
    save: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  await page.press("e", { ctrlKey: true });
  await page.settle(2);
}, 20_000);

test("an edit, the selection, the scroll, a mark and the undo history survive a change of language", async () => {
  shell.setInput("vim-style");
  await page.clickCell(MARKED_ROW, UNITS);
  await page.press("m");
  await page.press("a");
  await edit(LEFT_ROW, "7");
  expect(fileLine()).toContain(m.edits_count({ count: 1 }));
  expect(cellLine()).toContain(m.status_row({ row: num(LEFT_ROW + 1) }));
  await page.scrollTo(DEEP_SCROLL_PX);
  await page.settle(2);
  const top = scroller().scrollTop;
  expect(top).toBe(DEEP_SCROLL_PX);

  shell.language.choose("pt-BR");
  await page.settle(2);

  expect(getLocale()).toBe("pt-BR");
  expect(document.documentElement.lang).toBe("pt-BR");
  // The workspace and its tab are still open, with the edit.
  expect(shell.unsaved).toBe(true);
  expect(document.querySelectorAll(".dirty").length).toBeGreaterThan(0);
  expect(fileLine()).toContain(m.edits_count({ count: 1 }));
  expect(fileLine()).toContain(m.rows_count({ count: ROWS }));
  expect(fileLine()).toContain("4.812");
  // The selection is where it was, in the new language.
  expect(cellLine()).toContain(m.status_row({ row: num(LEFT_ROW + 1) }));
  // The scroll is where it was, and the gutter is grouped the new way.
  expect(scroller().scrollTop).toBe(top);
  const gutters = [...document.querySelectorAll("tbody td.gutter")].map((td) => td.textContent);
  expect(gutters.some((g) => g?.includes("1.2"))).toBe(true);
  expect(gutters.every((g) => !g?.includes(","))).toBe(true);

  // The mark is still set.
  await page.press("'");
  await page.press("a");
  await page.settle(1);
  expect(cellLine()).toContain(m.status_row({ row: num(MARKED_ROW + 1) }));

  // The undo history is still there.
  await page.press("u");
  expect(await until(page, () => fileLine().indexOf(m.edits_count({ count: 1 })) < 0)).toBe(true);
  expect(shell.unsaved).toBe(false);
  shell.setInput("default");
});

test("what the bar said before the change is not left in the language before", async () => {
  // The command line is vim-style's. Under the default keys a colon is typed
  // into the cell.
  shell.setInput("vim-style");
  await page.press(":");
  const cmd = document.querySelector<HTMLInputElement>("#status-cmd")!;
  cmd.value = ":nonsense";
  cmd.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await page.settle(1);
  expect(message()).toBe(m.not_a_command({ text: "nonsense" }));

  shell.language.choose("es");
  await page.settle(1);
  expect(message()).toBe("");
  shell.setInput("default");
});

test("a change made twice before the first settles ends in the last, with one of everything", async () => {
  shell.language.choose("en-US");
  shell.language.choose("es");
  shell.language.choose("pt-BR");
  await page.settle(2);
  expect(getLocale()).toBe("pt-BR");
  expect(document.documentElement.lang).toBe("pt-BR");

  // One keydown listener: Ctrl+B toggles the sidebar exactly once.
  const was = sidebarHidden();
  await page.press("b", { ctrlKey: true });
  expect(sidebarHidden()).toBe(!was);
  await page.press("b", { ctrlKey: true });
  expect(sidebarHidden()).toBe(was);

  // One sidebar, one tab, one set of controls.
  expect(document.querySelectorAll("#workspaces .ws").length).toBe(1);
  expect(document.querySelectorAll("#workspaces .tab").length).toBe(1);
  expect(document.querySelectorAll(".settings").length).toBe(1);
  expect(document.querySelectorAll("#panel .panel-head").length).toBeLessThanOrEqual(1);
});

test("a save in flight lands, and says so in the language chosen after it began", async () => {
  await edit(LEFT_ROW, "9");
  const saving = shell.save();
  expect(await until(page, () => release !== undefined)).toBe(true);
  shell.language.choose("en-US");
  await page.settle(1);
  release!();
  await saving;
  expect(message()).toBe(m.saved_path({ path: join(dir, "kept.uno") }));
  expect(shell.unsaved).toBe(false);
});

test("the settings menu and the sources panel open through the change are in the language chosen", async () => {
  await page.click("#panel-toggle");
  await page.click("#settings");
  await page.settle(1);
  shell.language.choose("es");
  await page.settle(1);
  expect(document.querySelector(".settings")?.hasAttribute("hidden")).toBe(false);
  expect(document.querySelector(".settings .title")?.textContent).toBe(m.settings_title());
  expect(document.querySelector("#panel")?.hasAttribute("hidden")).toBe(false);
  expect(document.querySelector("#sidebar-toggle")?.getAttribute("aria-label")).toBe(
    m.sidebar_aria(),
  );
  await page.click("#settings");
  await page.click("#panel-toggle");
});

test("a find in flight finishes, in the language chosen while it ran", async () => {
  // The search prompt is vim-style's too.
  shell.setInput("vim-style");
  await page.press("/");
  const cmd = document.querySelector<HTMLInputElement>("#status-cmd")!;
  cmd.value = "/zzz-not-in-the-file";
  cmd.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  shell.language.choose("pt-BR");
  expect(await until(page, () => message() !== "" && message() !== m.searching())).toBe(true);
  expect(message()).toContain(
    m.find_text_below({ text: "zzz-not-in-the-file", row: "1", column: "" }).slice(0, 4),
  );
});
