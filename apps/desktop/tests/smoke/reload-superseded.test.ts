/**
 * @fileoverview A reload or an append still reading its file when another
 * workspace opens, and an edit or a removal waiting behind such a reload,
 * over the real engine. The disk provider holds the file's open back, as a
 * slow disk or bucket would, until the other workspace has opened.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { UNITS } from "@main/smoke/fixture";
import type { Provider } from "@plugin";
import { multiProvider } from "@store";
import { diskProvider } from "@store/node";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "@renderer/shell/shell";
import { settle } from "@desktop-tests/settle";
import { FIXTURE, SECOND, bootShell } from "./dom-harness.ts";
import { domPage, until } from "./dom-page.ts";

/** How long a check gets, as cancel.test.ts allows its own. */
const CHECK_MS = 20_000;

/** How long the released open gets to land, as cancel.test.ts allows. */
const AFTER_MS = 100;

/** A folder of two files. A source of several files opens over the first
 * alone, and the panel offers to append the second. */
const FOLDER = mkdtempSync(join(tmpdir(), "uno-superseded-"));
const FIRST = join(FOLDER, "a.csv");
const GAINED = join(FOLDER, "b.csv");
/** The path a workspace of two sources saves to, which leaves it clean. */
const SAVED = join(FOLDER, "two.uno");

/**
 * gated wraps the disk provider. `hold` holds back the next open of `path`,
 * and resolves, once it is asked for, with the call that lets it go on.
 */
function gated(): { provider: Provider; hold: (path: string) => Promise<() => void> } {
  const disk = diskProvider();
  let next: { path: string; asked: (go: () => void) => void } | undefined;
  const provider: Provider = {
    ...disk,
    files: {
      label: disk.files.label,
      handles: (ref) => disk.files.handles(ref),
      async open(ref) {
        const held = next;
        if (held !== undefined && "path" in ref && ref.path === held.path) {
          next = undefined;
          await new Promise<void>((go) => held.asked(go));
        }
        return disk.files.open(ref);
      },
    },
  };
  const hold = (path: string): Promise<() => void> =>
    new Promise((asked) => {
      next = { path, asked };
    });
  return { provider, hold };
}

const said = (): string => document.querySelector("#status-msg")?.textContent ?? "";
const tabs = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".tab")].map((t) => t.dataset["source"] ?? "");

/** press sends `key` to the panel's list, for the line it has focused. */
function press(key: string): void {
  const list = document.querySelector(".panel-list")!;
  list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const page = domPage();
const gate = gated();
let shell: Shell;

/** opensOver opens `path`, whose one tab is `tab`, while a read is held back,
 * then lets it go on with `go`. The status line stays empty throughout. */
async function opensOver(path: string, go: () => void, tab: string): Promise<void> {
  await shell.openPath(path);
  await settle();
  expect(tabs()).toEqual([tab]);
  expect(said()).toBe("");

  go();
  await settle();
  await sleep(AFTER_MS);
  expect(tabs()).toEqual([tab]);
  expect(said()).toBe("");
}

/** editUnits leaves the panel with Esc and, in transform, types `value` into
 * the first row's units. */
async function editUnits(value: string): Promise<void> {
  press("Escape");
  await page.press("e", { ctrlKey: true });
  await page.clickCell(0, UNITS);
  await page.press("Enter");
  await page.setEditorValue(value);
  await page.press("Enter");
}

beforeAll(async () => {
  writeFileSync(FIRST, "region,units\nnorth,4\n");
  writeFileSync(GAINED, "region,units\nsouth,7\n");
  // As in the desktop engine, a source of several files reads through the
  // multi provider over the single-file one.
  shell = await bootShell({ pickSave: () => Promise.resolve(SAVED) }, [
    gate.provider,
    multiProvider([gate.provider]),
  ]);
}, CHECK_MS);

afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));

test(
  "a reload under way when another workspace opens ends quietly",
  async () => {
    // r on the tab's line in the panel reloads it, and the file waits to open.
    const asked = gate.hold(FIXTURE);
    shell.showPanel();
    press("r");
    const go = await asked;
    await opensOver(SECOND, go, "google-ads-sales");
  },
  CHECK_MS,
);

test(
  "an append under way when another workspace opens ends quietly",
  async () => {
    // A source of a.csv alone, whose folder also holds b.csv.
    await shell.openRef({
      name: "regions",
      parts: [{ ref: { name: "a.csv", path: FIRST } }],
      header: "first",
    });
    shell.showPanel();
    // The panel's foot offers to append b.csv on its wide button.
    const offered = (): boolean => document.querySelector(".panel-foot button.wide") !== null;
    expect(await until(page, offered)).toBe(true);

    // a on the source's line appends b.csv, which waits to open.
    const asked = gate.hold(GAINED);
    press("a");
    const go = await asked;
    await opensOver(FIXTURE, go, "sales-q3");
  },
  CHECK_MS,
);

test(
  "an edit waiting behind a reload when another workspace opens ends quietly",
  async () => {
    // r reloads the tab, and its file waits to open.
    const asked = gate.hold(FIXTURE);
    shell.showPanel();
    press("r");
    const go = await asked;

    // An edit made now waits in the engine behind the reload.
    await editUnits("1204");
    await opensOver(SECOND, go, "google-ads-sales");
  },
  CHECK_MS,
);

test(
  "a removal waiting behind a reload when another workspace opens ends quietly",
  async () => {
    // A saved workspace of two sources. r reloads the first, and its file
    // waits to open.
    await shell.addPaths([FIXTURE]);
    await shell.save();
    const asked = gate.hold(SECOND);
    shell.showPanel();
    press("r");
    const go = await asked;

    // Delete on the next source's line removes it, which waits behind the
    // reload.
    press("ArrowDown");
    press("Delete");
    await opensOver(FIXTURE, go, "sales-q3");
  },
  CHECK_MS,
);
