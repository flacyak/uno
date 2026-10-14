// @vitest-environment happy-dom
//
// Opening a file the platform already holds a reference to, with no dialog:
// what the web page does with a workspace the server kept. Runs over the real
// shell and engine.

import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "../src/renderer/shell/shell.ts";
import { FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** A second fixture beside the one the harness opens, so the open is seen to replace it. */
const OTHER = join(FIXTURE, "..", "google-ads-sales.csv");

const page = domPage();
let shell: Shell;

beforeAll(async () => {
  shell = await bootShell();
});

function tabNames(): string[] {
  return [...document.querySelectorAll("#workspaces .tab, .tab")].map((t) => t.textContent ?? "");
}

test("a ref handed to the shell opens in place of the open workspace, with no dialog", async () => {
  expect(tabNames().join(" ")).toContain("sales-q3.csv");
  await shell.openRef({ name: "google-ads-sales.csv", path: OTHER });
  expect(await until(page, () => tabNames().join(" ").includes("google-ads-sales.csv"))).toBe(true);
  expect(tabNames().join(" ")).not.toContain("sales-q3.csv");
  expect(shell.unsaved).toBe(false);
});
