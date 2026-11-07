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

import type { Shell } from "@renderer/shell/shell";
import { BARS, PIE, SCATTER, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, bootShell } from "./smoke/dom-harness.ts";

let shell: Shell;

/** Each window's name, in the order the file lists its charts. */
const NAMES = ["bars", "pie", "scatter"];

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
