/**
 * @fileoverview A chart refreshed by hand from its own window, through the real
 * shell and engine: r or the head's refresh button reads a rewritten file
 * again, the last picture faint until the new rows come, r twice reads it
 * once, a source of several files appends the new one alone, says why its
 * folder cannot be listed, and says nothing once another workspace has
 * opened, and the refresh of a carried source, or of one whose files the
 * open did not find, is off and says why. On a schedule, the first check
 * opens nothing over the file as it was read, one that comes due over the
 * rewritten file draws its new row and says nothing, r or Reload starts the
 * schedule over, and another workspace's open stops the schedule.
 *
 * @vitest-environment happy-dom
 */

import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { Engine, Refusal } from "@engine";
import { ROWS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import { Charts } from "@renderer/charts";
import { Refresher } from "@renderer/refresh";
import type { Shell } from "@renderer/shell/shell";
import { MINUTE_MS } from "@renderer/timing";
import { Workspace } from "@renderer/workspace";
import { multiProvider } from "@store";
import { diskProvider } from "@store/node";
import { BARS, SALES, carriedUnoOf, partsUnoOf, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, frame, until } from "./smoke/dom-page.ts";

/** A row of the sales export's shape, which a rewrite adds at its end. */
const ADDED_ROW = "2026-10-01,West,Ada Okafor,direct,1,1.00\r\n";

/** The shortest schedule a chart keeps: a check every minute. */
const EVERY_MINUTE = 1;

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

test("r draws the last picture faint over an empty track before the file read again tallies", async () => {
  const hear = vi.spyOn(Charts.prototype, "hear").mockImplementation(() => undefined);
  const relink = vi.spyOn(Engine.prototype, "relink");
  r();
  await relink.mock.results[0]!.value;
  await frame();
  const plot = box().querySelector<HTMLElement>(".chart-plot")!;
  const track = box().querySelector<HTMLElement>(".chart-coverage")!;
  expect([plot.classList.contains("chart-stale"), track.hidden]).toStrictEqual([true, false]);
  // The caption still counts the rows of the last read.
  expect(said()).toBe(m.rows_count({ count: ROWS + 2 }));
  expect(track.style.getPropertyValue("--read")).toBe("0");
  hear.mockRestore();
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

test("a chart over a carried source has its refresh off, and r says there is nothing to read again", async () => {
  const uno = join(dir, "carried.uno");
  await writeFile(uno, carriedUnoOf([BARS], new Uint8Array(await readFile(FIXTURE))));
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  expect(await counts(ROWS)).toBe(true);

  const again = box().querySelector<HTMLButtonElement>(".chart-refresh")!;
  const hint = m.chart_refresh_carried({ name: basename(FIXTURE) });
  expect([again.disabled, again.title]).toStrictEqual([true, hint]);
  const relink = vi.spyOn(Engine.prototype, "relink");
  expect(r()).toBe(false);
  expect([message(), relink.mock.calls.length]).toStrictEqual([hint, 0]);
  relink.mockRestore();
});

test("a chart over several files the open could not find has its refresh off, and r says why", async () => {
  const uno = join(dir, "lost.uno");
  await writeFile(uno, partsUnoOf([BARS], [join(dir, "lost", basename(PART_FIXTURES[0]!))]));
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  expect(await until(page, () => box()?.querySelector(".chart-state") !== null)).toBe(true);

  const again = box().querySelector<HTMLButtonElement>(".chart-refresh")!;
  const hint = m.chart_refresh_lost({ name: SALES });
  expect([again.disabled, again.title]).toStrictEqual([true, hint]);
  const relink = vi.spyOn(Engine.prototype, "relink");
  expect(r()).toBe(false);
  expect([message(), relink.mock.calls.length]).toStrictEqual([hint, 0]);
  relink.mockRestore();
});

test("a schedule opens nothing over the file as it was read, and draws the rewritten file's new row, saying nothing", async () => {
  await mkdir(join(dir, "scheduled"));
  const csv = join(dir, "scheduled", basename(FIXTURE));
  await copyFile(FIXTURE, csv);
  const uno = join(dir, "scheduled.uno");
  await writeFile(uno, unoOf([{ ...BARS, refresh: EVERY_MINUTE }], [], csv));
  const refresh = vi.spyOn(Workspace.prototype, "refresh");
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  expect(await counts(ROWS)).toBe(true);
  opened.mockClear();
  // The first check comes as the workspace opens.
  await vi.waitUntil(async () => (await refresh.mock.results.at(-1)?.value)?.t === "same");
  expect(paths()).toStrictEqual([]);

  await appendFile(csv, ADDED_ROW);
  const before = message();
  // A sleep moves the wall clock past the next check, and fires no timer.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + MINUTE_MS);
  shell.wake();
  vi.useRealTimers();
  expect(await counts(ROWS + 1)).toBe(true);
  expect(paths()).toStrictEqual([csv]);
  expect([message(), shell.unsaved]).toStrictEqual([before, false]);
  refresh.mockRestore();
});

test("r on a scheduled chart, or Reload on its source's line, starts its schedule over", async () => {
  const refreshed = vi.spyOn(Refresher.prototype, "refreshed");
  r();
  shell.showPanel();
  const line = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true });
  document.querySelector(".panel-list")!.dispatchEvent(line);
  shell.togglePanel();
  expect(refreshed.mock.calls).toStrictEqual([[SALES], [SALES]]);
  refreshed.mockRestore();
});

test("another workspace's open stops the schedule", async () => {
  const dispose = vi.spyOn(Refresher.prototype, "dispose");
  await shell.openRef({ name: basename(FIXTURE), path: FIXTURE });
  expect(dispose).toHaveBeenCalledOnce();
  dispose.mockRestore();
});
