/**
 * @fileoverview Opening a file the platform already holds a reference to, with
 * no dialog: what the web page does with a workspace the server kept. Runs over
 * the real shell and engine, with a host that answers the dialog and keeps
 * what it was asked to write.
 *
 * @vitest-environment happy-dom
 */

import { Blob } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import type { Shell } from "@renderer/shell/shell";
import { blobProvider } from "@store";
import { diskProvider } from "@store/node";
import { FIXTURE, bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** A second fixture beside the one the harness opens, so the open is seen to replace it. */
const OTHER = join(FIXTURE, "..", "google-ads-sales.csv");

const page = domPage();
let shell: Shell;

const dir = mkdtempSync(join(tmpdir(), "uno-open-ref-"));

/** What the save dialog answers next, and how often it was asked. */
let picked: string | undefined;
let asked = 0;
/** Every write the host was asked for. */
const writes: Array<{ path: string; bytes: Uint8Array }> = [];

/** kept is the first save's bytes as the engine is handed them: Node's own Blob, which crosses a MessageChannel whole. */
function kept(): globalThis.Blob {
  return new Blob([new Uint8Array(writes[0]!.bytes)]) as unknown as globalThis.Blob;
}

beforeAll(async () => {
  shell = await bootShell(
    {
      pickSave: () => {
        asked++;
        return Promise.resolve(picked);
      },
      save: (path, bytes) => {
        writes.push({ path, bytes });
        return Promise.resolve();
      },
    },
    // Bytes handed over open through the blob provider, as they do on a server.
    [diskProvider(), blobProvider()],
  );
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

test("a workspace handed over as bytes saves back to the place named with it, with no dialog", async () => {
  // The open workspace, saved once through the dialog: what a server keeps.
  picked = join(dir, "ads.uno");
  await shell.save();
  expect(asked).toBe(1);
  expect(writes.map((w) => w.path)).toEqual([picked]);

  // Handed back as its bytes, named for where it is kept.
  await shell.openRef({ name: "ads.uno", blob: kept() }, "ads.uno");
  expect(await until(page, () => tabNames().join(" ").includes("google-ads-sales.csv"))).toBe(true);
  expect(shell.unsaved).toBe(false);
  await shell.save();
  expect(asked).toBe(1);
  expect(writes.map((w) => w.path)).toEqual([picked, "ads.uno"]);

  // With no place named, the first save asks, as a dropped .uno does.
  await shell.openRef({ name: "ads.uno", blob: kept() });
  expect(await until(page, () => tabNames().join(" ").includes("google-ads-sales.csv"))).toBe(true);
  picked = undefined;
  await shell.save();
  expect(asked).toBe(2);
  expect(writes).toHaveLength(2);
});
