/**
 * @fileoverview A reload still reading its file when another workspace opens,
 * over the real engine. The disk provider holds the file's open back, as a
 * slow disk or bucket would, until the other workspace has opened.
 *
 * @vitest-environment happy-dom
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { Provider } from "@plugin";
import { diskProvider } from "@store/node";
import { beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "@renderer/shell/shell";
import { settle } from "@desktop-tests/settle";
import { FIXTURE, SECOND, bootShell } from "./dom-harness.ts";

/** How long a check gets, as cancel.test.ts allows its own. */
const CHECK_MS = 20_000;

/** How long the released open gets to land, as cancel.test.ts allows. */
const AFTER_MS = 100;

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

beforeAll(async () => {
  shell = await bootShell({}, [gate.provider]);
}, CHECK_MS);

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
