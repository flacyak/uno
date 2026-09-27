// @vitest-environment happy-dom
//
// What lands on which tab when the engine answers after Ctrl+Tab. An undo is
// asked of the tab showing, and the cell it brings back is that tab's: one the
// person has since left is not moved to in the other. Over the real shell and
// the real engine, so the window between asking and the answer is the
// channel's own, and Ctrl+Tab pressed straight after lands inside it.

import { dirname, join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { ROWS, UNITS, counted } from "../src/main/smoke/fixture.ts";
import type { KeyModifiers } from "../src/main/smoke/page.ts";
import { m } from "../src/paraglide/messages.js";
import { num } from "../src/renderer/locale.ts";
import { FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage } from "./smoke/dom-page.ts";

const FIXTURE_NAME = "sales-q3.csv";
const ADS_NAME = "google-ads-sales.csv";
/** A second export beside the fixture, for a workspace of two tabs. */
const ADS = join(dirname(FIXTURE), ADS_NAME);

/** Matches dom-page.ts's own budget. */
const TRIES = 150;

const page = domPage();

/**
 * A key the way `press` sends one, with no frame waited after it: the next
 * key goes before the engine has answered the first.
 */
function key(k: string, modifiers: KeyModifiers = {}): void {
  const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
  target?.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...modifiers }),
  );
}

/** until waits, a frame at a time, for `holds` to say so. */
async function until(holds: () => boolean): Promise<boolean> {
  for (let i = 0; i < TRIES && !holds(); i++) await page.settle(2);
  return holds();
}

/** The sidebar's tab for a source, by the name on it. */
function tabNamed(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".tab")].find((t) => t.title === name);
}

beforeAll(async () => {
  const shell = await bootShell();
  await shell.addPaths([ADS]);
}, 20_000);

test("an undo answered after Ctrl+Tab moves nothing on the tab now showing", async () => {
  // Adding shows the file added. Back to the fixture, where the edit goes.
  await page.press("PageUp", { ctrlKey: true });
  expect(await page.until([{ selector: "#status-file", includes: `${counted(ROWS)} rows` }])).toBe(
    true,
  );
  await page.press("e", { ctrlKey: true });
  expect(await page.until([{ row: 5, col: UNITS, equals: "1,101" }])).toBe(true);

  await page.clickCell(5, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue("1101");
  await page.press("Enter");
  expect(await page.until([{ selector: "#status-file", includes: "1 edit" }])).toBe(true);

  // Away from the cell, so the undo has somewhere to move back to.
  await page.clickCell(0, 0);
  await page.settle(1);
  expect(await page.text("#status-cell")).toContain(m.status_row({ row: num(1) }));

  // Ctrl+Z, and Ctrl+Tab before the engine has answered it.
  key("z", { ctrlKey: true });
  key("Tab", { ctrlKey: true });
  expect(await until(() => tabNamed(FIXTURE_NAME)?.querySelector(".dirty") === null)).toBe(true);

  // The other tab is showing, where it was left: on its first row.
  expect(await page.text("#status-file")).not.toContain(`${counted(ROWS)} rows`);
  expect(await page.text("#status-cell")).toContain(m.status_row({ row: num(1) }));
});

test("a source removed after Ctrl+Tab leaves the grid on the tab the workspace shows", async () => {
  await page.press("PageUp", { ctrlKey: true });
  expect(await page.until([{ selector: "#status-file", includes: `${counted(ROWS)} rows` }])).toBe(
    true,
  );

  // The other tab's ×, and Ctrl+Tab onto it before the engine has taken it out.
  const ads = tabNamed(ADS_NAME);
  expect(ads).toBeDefined();
  ads?.querySelector<HTMLElement>(".close")?.click();
  key("Tab", { ctrlKey: true });
  expect(await until(() => tabNamed(ADS_NAME) === undefined)).toBe(true);

  // The fixture is the tab the workspace shows, and the grid draws it.
  expect(await page.text("#status-file")).toContain(`${counted(ROWS)} rows`);
  expect(await page.text("thead")).toContain("units");
  expect(await page.text("thead")).not.toContain("Ad_ID");
});
