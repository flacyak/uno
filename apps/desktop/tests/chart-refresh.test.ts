/**
 * @fileoverview A chart refreshed by hand from its own window, through the real
 * shell and engine: r or the head's refresh button reads a rewritten file
 * again and draws the new rows, r twice reads it once, and a source of several
 * files appends the new one alone, says why its folder cannot be listed, and
 * says nothing once another workspace has opened.
 *
 * @vitest-environment happy-dom
 */

import { appendFile, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { Engine, Refusal } from "@engine";
import { ROWS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import type { Shell } from "@renderer/shell/shell";
import { multiProvider } from "@store";
import { diskProvider } from "@store/node";
import { BARS, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, frame, until } from "./smoke/dom-page.ts";

/** A row of the sales export's shape, which a rewrite adds at its end. */
const ADDED_ROW = "2026-10-01,West,Ada Okafor,direct,1,1.00\r\n";

/** How many files core's testdata cuts the sales export into, beside it. */
const PART_COUNT = 3;
const PART_FIXTURES = Array.from({ length: PART_COUNT }, (_, i) =>
  join(dirname(FIXTURE), `sales-q3-part-${i + 1}.csv`),
);
const PART_ROWS = ROWS / PART_COUNT;

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
  shell = await bootShell({}, [disk, multiProvider([disk])]);
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

test("r on a chart over several files appends the new one alone, and says when there is none", async () => {
  const folder = join(dir, "parts");
  await mkdir(folder);
  const copies = PART_FIXTURES.map((part) => join(folder, basename(part)));
  await Promise.all(copies.slice(0, -1).map((to, i) => copyFile(PART_FIXTURES[i]!, to)));
  const parts = copies.slice(0, -1).map((path) => ({ ref: { name: basename(path), path } }));
  await shell.openRef({ name: "sales-q3", parts, header: "first" });
  shell.insertChartHere();
  expect(await until(page, () => document.querySelector(".chart-form") !== null)).toBe(true);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  document.querySelector(".chart-form select")!.dispatchEvent(enter);
  expect(await counts(PART_ROWS * parts.length)).toBe(true);

  await copyFile(PART_FIXTURES.at(-1)!, copies.at(-1)!);
  const append = vi.spyOn(Engine.prototype, "append");
  r();
  expect(await counts(PART_ROWS * copies.length)).toBe(true);
  const added = { name: basename(copies.at(-1)!), path: copies.at(-1) };
  expect(append.mock.calls.map(([, files]) => files)).toStrictEqual([[added]]);
  append.mockRestore();
  r();
  const none = m.refresh_no_new_files({ name: "sales-q3" });
  expect(await until(page, () => message() === none)).toBe(true);

  // A folder that cannot be listed says why, where it would say nothing is new.
  const offline = "the bucket is offline";
  const refused = new Refusal({ t: "text", text: offline });
  const list = vi.spyOn(Engine.prototype, "list").mockRejectedValueOnce(refused);
  r();
  expect(await until(page, () => message() === offline)).toBe(true);
  list.mockRestore();
});

test("a folder refresh still listing when another workspace opens ends there, without a word", async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let listed: Promise<unknown> = held;
  // The first listing waits for the release, then asks the engine as the next one does.
  const gated = vi
    .spyOn(Engine.prototype, "list")
    .mockImplementationOnce(function (this: Engine, path, cursor) {
      const later = held.then(() => this.list(path, cursor));
      listed = later;
      return later;
    });
  r();
  const uno = join(dir, "q3.uno");
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  const before = message();
  release();
  // The open closed the engine the listing asked, so the listing fails.
  await listed.catch(() => undefined);
  await frame();
  expect(message()).toBe(before);
  gated.mockRestore();
});
