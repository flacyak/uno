/**
 * @fileoverview r pressed twice on a tab's line in the panel reads the file
 * once. The second press comes before the first is answered, and joins it.
 * Runs over the real shell and engine.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test, vi } from "vite-plus/test";

import { diskProvider } from "@store/node";
import type { Shell } from "@renderer/shell/shell";
import { FIXTURE, SECOND, bootShell } from "./smoke/dom-harness.ts";

const disk = diskProvider();
const opened = vi.spyOn(disk.files, "open");
let shell: Shell;

beforeAll(async () => {
  shell = await bootShell({}, [disk]);
}, 20_000);

test("r pressed twice on a tab's line reads its file once", async () => {
  opened.mockClear();
  shell.showPanel();
  const list = document.querySelector(".panel-list")!;
  const press = (): boolean =>
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  press();
  press();

  // The engine answers in the order asked, so once a later open is answered,
  // so is every reload asked before it.
  await shell.addPaths([SECOND]);
  const reloads = opened.mock.calls.filter(([ref]) => "path" in ref && ref.path === FIXTURE);
  expect(reloads).toHaveLength(1);
});
