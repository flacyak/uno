/**
 * @fileoverview A chart refreshed by hand from its own window, through the real
 * shell and engine: r or the head's refresh button reads a rewritten file
 * again and draws the new rows, and r twice reads it once.
 *
 * @vitest-environment happy-dom
 */

import { appendFile, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { Engine } from "@engine";
import { ROWS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import type { Shell } from "@renderer/shell/shell";
import { diskProvider } from "@store/node";
import { BARS, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** A row of the sales export's shape, which a rewrite adds at its end. */
const ADDED_ROW = "2026-10-01,West,Ada Okafor,direct,1,1.00\r\n";

const page = domPage();
const disk = diskProvider();
const opened = vi.spyOn(disk.files, "open");
let shell: Shell;
let dir: string;

const box = (): HTMLElement => document.querySelector<HTMLElement>(".chart")!;
const said = (): string => document.querySelector(".chart .chart-said")?.textContent ?? "";
const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const r = (): boolean =>
  box().dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
/** Waits for the chart's caption to count `rows` rows, its tally complete. */
const counts = (rows: number): Promise<boolean> =>
  until(page, () => said().startsWith(m.rows_count({ count: rows })));
/** The paths the disk opened since the last clear, in order. */
const paths = (): string[] =>
  opened.mock.calls.flatMap(([ref]) => ("path" in ref ? [ref.path] : []));

beforeAll(async () => {
  shell = await bootShell({}, [disk]);
  dir = await mkdtemp(join(tmpdir(), "uno-chart-refresh-"));
}, FIRST_ROWS_MS);

test("r on a chart reads its rewritten file again, draws the new row, and leaves the workspace clean", async () => {
  const csv = join(dir, basename(FIXTURE));
  await copyFile(FIXTURE, csv);
  const uno = join(dir, "q3.uno");
  await writeFile(uno, unoOf([BARS], [], csv));
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  expect(await counts(ROWS)).toBe(true);

  await appendFile(csv, ADDED_ROW);
  opened.mockClear();
  expect(r()).toBe(false);
  expect(await counts(ROWS + 1)).toBe(true);
  expect(paths()).toStrictEqual([csv]);
  expect(message().startsWith(m.reloaded_name({ name: basename(csv) }))).toBe(true);
  expect(shell.unsaved).toBe(false);
});

test("r twice, and the head's button after it, send one relink between them", async () => {
  const relink = vi.spyOn(Engine.prototype, "relink");
  await appendFile(join(dir, basename(FIXTURE)), ADDED_ROW);
  r();
  r();
  box().querySelector<HTMLButtonElement>(".chart-refresh")!.click();
  expect(relink).toHaveBeenCalledOnce();
  expect(await counts(ROWS + 2)).toBe(true);
  relink.mockRestore();
});
