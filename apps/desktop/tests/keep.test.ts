/**
 * @fileoverview A workspace kept where the host keeps a write nobody asked
 * for, as the hosted page's gate does, through the real shell and engine.
 * Once an index the open read is complete and its chart folded, a workspace
 * nobody edited is written once, saying nothing and leaving it clean, and
 * the write holds the index whole and the fold, so the next open of it is
 * not kept again. An edit keeps nothing: Ctrl+S saves it with the index,
 * as it does today. An edit made while a keep is out stays unsaved, and
 * Ctrl+S made then waits for the keep, then writes its own.
 *
 * @vitest-environment happy-dom
 */

import { appendFile, copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";

import { readContainer } from "@document";
import { TUNING } from "@engine";
import { ROWS, UNITS } from "@main/smoke/fixture";
import { m } from "@paraglide/messages";
import type { Provider } from "@plugin";
import type { Shell } from "@renderer/shell/shell";
import { diskProvider } from "@store/node";
import { BARS, SALES, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** A row of the sales export's shape, added past its first chunk. */
const ADDED_ROW = "2026-10-01,West,Ada Okafor,direct,1,1.00\r\n";
/** Enough added rows that the export is longer than one chunk, so it opens with its index running. */
const ADDED = Math.ceil(TUNING.chunkBytes / ADDED_ROW.length);
const LONG_ROWS = ROWS + ADDED;
/** Frames waited for a write that should not come. */
const QUIET_FRAMES = 20;

const page = domPage();
/** While set, the disk's reads past a file's first chunk wait for it. */
let held: Promise<void> | undefined;
/** While set, a keep waits for it before it writes. */
let keeping: Promise<void> | undefined;
const keep = vi.fn(async (path: string, bytes: Uint8Array) => {
  await keeping;
  await writeFile(path, bytes);
});
const save = vi.fn((path: string, bytes: Uint8Array) => writeFile(path, bytes));

/** `provider`, with its reads past the first chunk waiting for `held`. */
function holding(provider: Provider): Provider {
  const { files } = provider;
  return {
    ...provider,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const file = await files.open(ref);
        return {
          size: file.size,
          version: file.version,
          modified: file.modified,
          async read(offset, length) {
            if (offset >= TUNING.chunkBytes) await held;
            return file.read(offset, length);
          },
          close: () => file.close(),
        };
      },
    },
  };
}

let shell: Shell;
let dir: string;

const said = (): string => document.querySelector(".chart .chart-said")?.textContent ?? "";
const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const counted = (): Promise<boolean> =>
  until(page, () => said().startsWith(m.rows_count({ count: LONG_ROWS })));

beforeAll(async () => {
  shell = await bootShell({ keep, save }, [holding(diskProvider())]);
  dir = await mkdtemp(join(tmpdir(), "uno-keep-"));
}, FIRST_ROWS_MS);

beforeEach(() => {
  keep.mockClear();
  save.mockClear();
});

/** Opens a .uno of a chart over a copy of the export longer than one chunk, its index running. */
async function long(name: string): Promise<string> {
  const csv = join(dir, `${name}.csv`);
  await copyFile(FIXTURE, csv);
  await appendFile(csv, ADDED_ROW.repeat(ADDED));
  const uno = join(dir, `${name}.uno`);
  await writeFile(uno, unoOf([BARS], [], csv));
  await shell.openRef({ name: basename(uno), path: uno }, uno);
  return uno;
}

/** Waits some frames, so a write that is coming has come. */
async function quiet(): Promise<void> {
  for (let i = 0; i < QUIET_FRAMES; i++) await page.settle(1);
}

/** Edits a cell of the showing source. */
async function edit(): Promise<void> {
  await page.press("e", { ctrlKey: true });
  await page.clickCell(0, UNITS);
  await page.settle(1);
  await page.press("Enter");
  await page.setEditorValue("8");
  await page.press("Enter");
  expect(await until(page, () => shell.unsaved)).toBe(true);
}

test(
  "a workspace nobody edited is kept once, saying nothing, with its index whole and its chart's fold, and opens again without another",
  async () => {
    const before = message();
    const uno = await long("kept");
    expect(await counted()).toBe(true);
    expect(await until(page, () => keep.mock.calls.length > 0)).toBe(true);
    await quiet();
    expect(keep).toHaveBeenCalledOnce();
    expect(keep.mock.calls[0]![0]).toBe(uno);
    expect([shell.unsaved, message(), save.mock.calls.length]).toStrictEqual([false, before, 0]);
    const cache = readContainer(basename(uno), keep.mock.calls[0]![1]).cache?.get(SALES);
    expect([cache?.complete, cache?.charts?.[BARS.id] !== undefined]).toStrictEqual([true, true]);

    keep.mockClear();
    await shell.openRef({ name: basename(uno), path: uno }, uno);
    expect(await counted()).toBe(true);
    await quiet();
    expect(keep).not.toHaveBeenCalled();
  },
  FIRST_ROWS_MS,
);

test(
  "an edit keeps nothing, and Ctrl+S saves it with the index",
  async () => {
    let release = (): void => {};
    held = new Promise((resolve) => (release = resolve));
    const uno = await long("edited");
    await edit();
    held = undefined;
    release();
    expect(await counted()).toBe(true);
    await quiet();
    expect(keep).not.toHaveBeenCalled();

    await shell.save();
    expect(save.mock.calls.map(([path]) => path)).toStrictEqual([uno]);
    expect(readContainer(basename(uno), save.mock.calls[0]![1]).cache?.get(SALES)?.complete).toBe(
      true,
    );
    expect(shell.unsaved).toBe(false);
  },
  FIRST_ROWS_MS,
);

/** Opens a long export with its keep held, and waits for the keep to be out. */
async function keepOut(name: string): Promise<{ uno: string; release: () => void }> {
  let release = (): void => {};
  keeping = new Promise((resolve) => (release = resolve));
  const uno = await long(name);
  expect(await counted()).toBe(true);
  expect(await until(page, () => keep.mock.calls.length > 0)).toBe(true);
  keeping = undefined;
  return { uno, release };
}

test(
  "an edit made while a keep is out stays unsaved once the keep is written",
  async () => {
    const { release } = await keepOut("meanwhile");
    await edit();
    release();
    await quiet();
    expect([keep.mock.calls.length, shell.unsaved]).toStrictEqual([1, true]);
  },
  FIRST_ROWS_MS,
);

test(
  "Ctrl+S while a keep is out waits for it, then writes its own",
  async () => {
    const { uno, release } = await keepOut("waited");
    const saved = shell.save();
    await quiet();
    expect(save).not.toHaveBeenCalled();
    release();
    await saved;
    expect(save.mock.calls.map(([path]) => path)).toStrictEqual([uno]);
    expect([keep.mock.calls.length, shell.unsaved]).toStrictEqual([1, false]);
  },
  FIRST_ROWS_MS,
);
