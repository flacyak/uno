/**
 * @fileoverview An open that waits on the chart layer's first import. It has to
 * lose to any open that ends while it waits, so load imports the layer before
 * it asks whether its open still stands.
 *
 * The layer has to be unloaded when the test starts, so this has its own file.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

import { BARS, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, SECOND, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The second export's rows, which the status bar counts once it shows. */
const SECOND_ROWS = "2,600 rows";

const page = domPage();
const file = (): string => document.querySelector("#status-file")?.textContent ?? "";

test(
  "an open waiting on the layer's import loses to one that ends first",
  async () => {
    let asked = false;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("@renderer/chart/layer", async (actual) => {
      asked = true;
      await held;
      return actual();
    });
    const shell = await bootShell();
    const path = join(mkdtempSync(join(tmpdir(), "uno-charts-load-")), "slow.uno");
    await writeFile(path, unoOf([BARS]));

    const slow = shell.openRef({ name: "slow.uno", path });
    expect(await until(page, () => asked)).toBe(true);
    await shell.openPath(SECOND);
    release();
    await slow;

    expect(file()).toContain(SECOND_ROWS);
    expect(document.querySelectorAll(".chart")).toHaveLength(0);
  },
  FIRST_ROWS_MS,
);
