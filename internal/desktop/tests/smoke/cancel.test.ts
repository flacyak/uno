// @vitest-environment happy-dom
//
// The × on a source still opening, over the real engine. The disk provider
// is wrapped so the second fixture's open sits where a slow bucket would
// leave it: format sniffed, first chunk on its way, waiting for its sample
// rows with its row on screen.

import { setTimeout as sleep } from "node:timers/promises";

import type { Provider } from "@uno/grid/plugin";
import { diskProvider } from "@uno/grid/store/node";
import { beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "../../src/renderer/shell/shell.ts";
import { settle } from "../settle.ts";
import { SECOND, bootShell } from "./dom-harness.ts";

/** How long the opening row gets to appear, and how often the DOM is polled. */
const ROW_MS = 5_000;
const POLL_MS = 20;

/** How long the released read gets to land on the closed file. */
const AFTER_MS = 100;

/**
 * held returns the disk provider with one read of `path` held back: the
 * first past the front of the file, which is the index pass's first chunk,
 * after the format sniff at offset 0. `indexing` resolves when it is asked
 * for, and from then until `go` is called the open waits for its sample
 * rows. Every other file, and every later read, is served as it is.
 */
function held(path: string): { provider: Provider; indexing: Promise<void>; go: () => void } {
  const disk = diskProvider();
  const { files } = disk;
  let began = (): void => {};
  const indexing = new Promise<void>((resolve) => {
    began = resolve;
  });
  let go = (): void => {};
  const released = new Promise<void>((resolve) => {
    go = resolve;
  });
  let holding = true;
  const provider: Provider = {
    ...disk,
    files: {
      label: files.label,
      handles: (ref) => files.handles(ref),
      async open(ref) {
        const source = await files.open(ref);
        if (!("path" in ref) || ref.path !== path) return source;
        return {
          size: source.size,
          version: source.version,
          async read(offset, length) {
            if (holding && offset > 0) {
              holding = false;
              began();
              await released;
            }
            return source.read(offset, length);
          },
          close: () => source.close(),
        };
      },
    },
  };
  return { provider, indexing, go };
}

/** until polls for `find` to answer, giving up after ROW_MS. */
async function until<T>(find: () => T | null): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < ROW_MS) {
    const found = find();
    if (found !== null) return found;
    await sleep(POLL_MS);
  }
  throw new Error(`nothing was found within ${ROW_MS}ms`);
}

const status = (): HTMLElement => document.querySelector<HTMLElement>("#status-msg")!;
const tabs = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".tab")].map((t) => t.dataset["source"] ?? "");

const disk = held(SECOND);
let shell: Shell;

beforeAll(async () => {
  shell = await bootShell({}, [disk.provider]);
}, 20_000);

test("the × on a source still opening stops it, and the file then opens again under its plain id", async () => {
  const adding = shell.addPaths([SECOND]);
  const row = await until(() => document.querySelector<HTMLElement>(".tab-opening"));
  expect(row.querySelector(".name")?.textContent).toBe("google-ads-sales.csv");
  // The engine has asked for its first chunk and waits for its sample rows.
  await disk.indexing;
  expect(document.querySelector(".tab-opening")).toBe(row);

  // The row goes at once, and the stop is said.
  row.querySelector<HTMLElement>(".close")!.click();
  expect(document.querySelector(".tab-opening")).toBeNull();
  expect(tabs()).toEqual(["sales-q3"]);
  expect(status().textContent).toBe("stopped opening google-ads-sales.csv");
  expect(status().className).toBe("");

  // The add is over once the engine has refused the open as cancelled, with
  // nothing more said of it.
  await adding;
  expect(tabs()).toEqual(["sales-q3"]);
  expect(status().textContent).toBe("stopped opening google-ads-sales.csv");

  // The held chunk goes on to a closed file, which is left unsaid too.
  disk.go();
  await settle();
  await sleep(AFTER_MS);
  expect(tabs()).toEqual(["sales-q3"]);
  expect(status().textContent).toBe("stopped opening google-ads-sales.csv");
  expect(status().className).toBe("");

  // The cancelled open left no source behind: the engine would have named a
  // second google-ads-sales_2.
  await shell.addPaths([SECOND]);
  expect(tabs()).toEqual(["sales-q3", "google-ads-sales"]);
  expect(status().textContent).toBe("added google-ads-sales.csv");
}, 20_000);
