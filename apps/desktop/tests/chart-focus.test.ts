/**
 * @fileoverview F6 moves the keys from the grid through the chart windows front
 * to back and on to the grid, and Shift+F6 the other way, under either input
 * strategy, through the real shell and engine.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import type { Shell } from "@renderer/shell/shell";
import { BARS, PIE, SCATTER, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

const page = domPage();
let shell: Shell;

/** Each window's name, in the order the file lists its charts. */
const NAMES = ["bars", "pie", "scatter"];

/** The units of the sales export's first row, which show once it has loaded. */
const FIRST_UNITS = "1,204";

const grid = (): HTMLElement => document.querySelector<HTMLElement>("#content")!;
const windows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".chart")];

/** Presses `key` with `held` where the keys are, and names where they went. */
function press(key: string, held: KeyboardEventInit = {}): string {
  const init = { key, bubbles: true, cancelable: true, ...held };
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", init));
  const at = document.activeElement;
  return at === grid() ? "grid" : String(NAMES[windows().findIndex((box) => box === at)]);
}

const f6 = (back = false): string => press("F6", { shiftKey: back });

/** Opens a .uno of bars, a pie and a scatter, in that order, as `name`. */
async function open(name: string): Promise<void> {
  const path = join(mkdtempSync(join(tmpdir(), "uno-chart-focus-")), name);
  await writeFile(path, unoOf([BARS, PIE, SCATTER]));
  await shell.openRef({ name, path });
}

beforeAll(async () => {
  shell = await bootShell();
}, FIRST_ROWS_MS);

for (const input of ["default", "vim-style"] as const) {
  test(`under ${input}, F6 goes front to back through the windows and back to the grid`, async () => {
    shell.setInput(input);
    await open(`${input}.uno`);
    // A window that had the keys stands over those never raised, and of
    // those the last one made stands over the rest.
    windows()[0]!.focus();
    grid().focus();

    expect([f6(), f6(), f6(), f6()]).toStrictEqual(["bars", "scatter", "pie", "grid"]);
    // Each window F6 reached was raised in turn, so bars is now the back one.
    expect([f6(true), f6(true), f6()]).toStrictEqual(["bars", "scatter", "bars"]);
    expect([f6(true), f6(true), f6(true)]).toStrictEqual(["scatter", "pie", "grid"]);
  });
}

test("Ctrl+Shift+F gives the keys to the window on top under either keys", async () => {
  await open("front.uno");
  const front = { ctrlKey: true, shiftKey: true };
  expect(press("F", front)).toBe("scatter");
  for (const [input, raised] of [
    ["default", 0],
    ["vim-style", 1],
  ] as const) {
    shell.setInput(input);
    windows()[raised]!.focus();
    grid().focus();
    expect(press("F", front), input).toBe(NAMES[raised]);
  }
});

test("Ctrl+E and Ctrl+Shift+G on a window reach the shell", async () => {
  await open("chords.uno");
  windows()[1]!.focus();
  press("e", { ctrlKey: true });
  expect(document.querySelector("#status-mode")?.textContent).toBe(m.mode_transform());
  press("G", { ctrlKey: true, shiftKey: true });
  expect(await until(page, () => document.querySelector(".chart-form") !== null)).toBe(true);
});

test("F6 in the cell editor leaves the keys there", async () => {
  shell.setInput("default");
  await open("editing.uno");
  press("e", { ctrlKey: true });
  expect(await page.until([{ row: 0, col: UNITS, equals: FIRST_UNITS }])).toBe(true);
  await page.clickCell(0, UNITS);
  await page.press("Enter");
  const editor = document.querySelector(".cell-editor");
  expect(editor).not.toBeNull();
  await page.press("F6");
  expect(document.activeElement).toBe(editor);
});
