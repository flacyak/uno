/**
 * @fileoverview A chart changed from its own window, through the real shell
 * and engine: the edit button opens the chart form on the chart, Apply on
 * another column refolds and redraws it, and a new title reads no bytes.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test, vi } from "vite-plus/test";

import { REGION, REP } from "@main/smoke/fixture";
import type { Provider } from "@plugin";
import { madeTitle } from "@renderer/chart/window";
import type { Shell } from "@renderer/shell/shell";
import { diskProvider } from "@store/node";
import { BARS, SALES, unoOf } from "./charted.ts";
import { FIRST_ROWS_MS, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The sales export's regions and reps, as their tallies send them. */
const REGIONS = ["East", "North", "South", "West"];
const REPS = ["Ada Okafor", "Ben Iyer", "Cai Moreau", "Dara Nkemi"];

const page = domPage();
let shell: Shell;
/** How many reads the engine has asked of the disk. */
let reads = 0;

const labels = (): string =>
  [...document.querySelectorAll(".chart-bar-label")].map((at) => at.textContent).join();
const head = (): string | null | undefined => document.querySelector(".chart-title")?.textContent;
const form = (): Element | null => document.querySelector(".chart-form");

/** A disk provider that counts its reads. */
function counting(): Provider {
  const disk = diskProvider();
  const { files } = disk;
  const open: Provider["files"]["open"] = async (ref) => {
    const source = await files.open(ref);
    const read = (offset: number, length: number): Promise<Uint8Array> => {
      reads++;
      return source.read(offset, length);
    };
    return { size: source.size, modified: source.modified, read, close: () => source.close() };
  };
  return { ...disk, files: { label: files.label, handles: (ref) => files.handles(ref), open } };
}

/** Opens the chart form from the window's edit button, and gives its By select. */
async function edit(): Promise<HTMLSelectElement> {
  document.querySelector<HTMLElement>(".chart-edit")!.click();
  expect(await until(page, () => form() !== null)).toBe(true);
  return document.querySelector<HTMLSelectElement>('.chart-form select[name="by"]')!;
}

/** Presses Enter on `at`, and waits for the form to close. */
async function apply(at: Element): Promise<void> {
  at.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(await until(page, () => form() === null)).toBe(true);
}

beforeAll(async () => {
  shell = await bootShell({}, [counting()]);
  const path = join(mkdtempSync(join(tmpdir(), "uno-chart-change-")), "q3.uno");
  await writeFile(path, unoOf([BARS]));
  await shell.openRef({ name: "q3.uno", path });
}, FIRST_ROWS_MS);

test("the edit button opens the form on the chart, and Apply on rep refolds and redraws it", async () => {
  expect(await until(page, () => labels() === REGIONS.join())).toBe(true);
  const by = await edit();
  expect(by.value).toBe(String(REGION));
  const before = reads;
  by.value = String(REP);
  by.dispatchEvent(new Event("change"));
  await apply(by);
  expect(head()).toBe(`${SALES} · ${madeTitle({ t: "bars", by: { col: REP, header: "rep" } })}`);
  expect(await until(page, () => labels() === REPS.join())).toBe(true);
  expect(reads).toBeGreaterThan(before);
  expect(document.querySelector(".ws.open .dirty")).not.toBeNull();
  expect(document.activeElement).toBe(document.querySelector(".chart"));
});

test("a new title shows at once, and the tally the engine sends again reads no bytes", async () => {
  await edit();
  const title = document.querySelector<HTMLInputElement>(".chart-form input")!;
  title.value = "Who sold";
  const heard = vi.spyOn(shell.charts!, "hear");
  const before = reads;
  await apply(title);
  expect(head()).toBe(`${SALES} · Who sold`);
  expect(await until(page, () => heard.mock.calls.length > 0)).toBe(true);
  expect([reads, labels()]).toStrictEqual([before, REPS.join()]);
});
