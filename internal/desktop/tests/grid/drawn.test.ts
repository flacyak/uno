// @vitest-environment happy-dom
//
// What the grid and the status bar draw of a sheet at its edges: a file with a
// header and no rows, and a header the file left blank. Over the real shell
// and the real engine, as history.test.ts is, since both come from what the
// engine makes of the bytes.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { num } from "../../src/renderer/locale.ts";
import type { Shell } from "../../src/renderer/shell/shell.ts";
import { m } from "../../src/paraglide/messages.js";
import { bootShell } from "../smoke/dom-harness.ts";
import { domPage } from "../smoke/dom-page.ts";

const page = domPage();
let shell: Shell;
let dir: string;

beforeAll(async () => {
  shell = await bootShell();
  dir = await mkdtemp(join(tmpdir(), "uno-drawn-"));
}, 20_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** open writes a file and opens it, waiting for the status bar to count its rows. */
async function open(name: string, text: string, rows: number): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, text);
  await shell.openPath(path);
  const counted = m.rows_count({ count: rows });
  expect(await page.until([{ selector: "#status-file", includes: counted }])).toBe(true);
}

test("a header with no rows under it is drawn alone, and the status bar names no row", async () => {
  await open("header-only.csv", "name,total\n", 0);

  expect(await page.allText("thead th .colname")).toEqual(["name", "total"]);
  expect(await page.count("tbody tr"), "no phantom row").toBe(0);
  expect(await page.text("#status-cell")).toBe("name");
});

test("a column the file left nameless is called by its place, in the header and the status bar", async () => {
  await open("index-column.csv", ",region\n0,West\n1,East\n", 2);

  const first = m.column_unnamed({ number: 1 });
  expect(await page.allText("thead th .colname")).toEqual([first, "region"]);
  expect(await page.hasClass("thead th .colname", "unnamed", 0)).toBe(true);
  expect(await page.text("#status-cell")).toBe(`${first} · ${m.status_row({ row: num(1) })}`);

  // The column is one to be on and to leave, like any other.
  await page.press("ArrowRight");
  expect(await page.text("#status-cell")).toBe(`region · ${m.status_row({ row: num(1) })}`);
  await page.press("ArrowLeft");
  expect(await page.text("#status-cell")).toBe(`${first} · ${m.status_row({ row: num(1) })}`);
});
