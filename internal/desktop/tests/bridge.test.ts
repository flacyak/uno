// Checks that the IPC channel names in src/preload and src/main agree, by
// reading the source text. Channel names are plain strings, so a rename on
// one side only gets past the type checker.
//
// Preload's implementation of Bridge is already type-checked. This file
// covers only the string literals, and whether main registers a handler or
// a listener for each one.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const PRELOAD = readFileSync(join(SRC, "preload/index.ts"), "utf8");
const MAIN = readFileSync(join(SRC, "main/index.ts"), "utf8");
const RENDERER_MAIN = readFileSync(join(SRC, "renderer/main.ts"), "utf8");

/** Every match of a pattern with one capture group, in source order.
 * Duplicates are kept. */
function captures(re: RegExp, src: string): string[] {
  return [...src.matchAll(re)].map((m) => {
    const group = m[1];
    if (group === undefined) throw new Error(`${re.source} matched without capturing`);
    return group;
  });
}

/** The capture of a pattern that must match once. Throws on a miss, so a
 * rewritten source fails loudly. */
function requireOne(re: RegExp, src: string, what: string): string {
  const m = src.match(re);
  if (m?.[1] === undefined) throw new Error(`could not find ${what}`);
  return m[1];
}

/** The channel names inside a `"a" | "b" | "c"` union, in source order. */
function unionMembers(union: string): string[] {
  return captures(/"([^"]+)"/g, union);
}

// --------------------------------------------------------- renderer -> main

// Every ipcRenderer.invoke/send in preload, from both `bridge` and
// `unoMenu`.
const PRELOAD_SENDS = new Set(captures(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g, PRELOAD));

// Every ipcMain.handle/on in main. The pattern passes over
// ipcMain.removeHandler.
const MAIN_HANDLES = new Set(captures(/ipcMain\.(?:handle|on)\("([^"]+)"/g, MAIN));

test("the renderer -> main extraction found the nine channels this file assumes", () => {
  // Sized on purpose: a regex that stops matching would leave the
  // assertions below trivially true.
  expect(PRELOAD_SENDS.size).toBe(9);
  expect(MAIN_HANDLES.size).toBe(9);
});

test("every channel the renderer sends has a receiver in main", () => {
  const missing = [...PRELOAD_SENDS].filter((c) => !MAIN_HANDLES.has(c));
  expect(missing).toEqual([]);
});

test("no handler in main goes uncalled from preload", () => {
  const orphaned = [...MAIN_HANDLES].filter((c) => !PRELOAD_SENDS.has(c));
  expect(orphaned).toEqual([]);
});

// --------------------------------------------------------- main -> renderer

// Main sends through webContents.send, sender.postMessage, and buildMenu's
// local `send(channel)` helper. `pick(name)` sends the fixed channel
// "menu:input" with `name` as the payload. Both shapes are read.
const MAIN_SENDS = new Set([
  ...captures(/(?:webContents\.send|sender\.postMessage)\("([^"]+)"/g, MAIN),
  ...captures(/\bsend\("([^"]+)"\)/g, MAIN),
]);

// unoMenu.on takes `channel` as a parameter, so its channels appear only in
// the union type it is declared with.
const PRELOAD_MENU_UNION = unionMembers(
  requireOne(/on\(\s*channel:\s*([^,]+),/, PRELOAD, "unoMenu.on's channel union"),
);

const PRELOAD_LISTENS = new Set([
  ...captures(/ipcRenderer\.on\("([^"]+)"/g, PRELOAD),
  ...PRELOAD_MENU_UNION,
]);

test("the main -> renderer extraction found the ten channels this file assumes", () => {
  expect(MAIN_SENDS.size).toBe(10);
  expect(PRELOAD_LISTENS.size).toBe(10);
});

test("every channel main sends is listened for in preload", () => {
  const unheard = [...MAIN_SENDS].filter((c) => !PRELOAD_LISTENS.has(c));
  expect(unheard).toEqual([]);
});

test("every channel preload listens for is sent by main somewhere", () => {
  const unsent = [...PRELOAD_LISTENS].filter((c) => !MAIN_SENDS.has(c));
  expect(unsent).toEqual([]);
});

// -------------------------------------------------------------- MenuChannel

const RENDERER_MENU_UNION = unionMembers(
  requireOne(/type MenuChannel =\s*([^;]+);/, RENDERER_MAIN, "MenuChannel"),
);

test("MenuChannel in the renderer names the same six channels as preload's union", () => {
  expect(RENDERER_MENU_UNION.length).toBe(6);
  expect(PRELOAD_MENU_UNION.length).toBe(6);
  expect([...RENDERER_MENU_UNION].sort()).toEqual([...PRELOAD_MENU_UNION].sort());
});

// ------------------------------------------------- file:pick-save, file:open

test("each of the driven branch's removeHandlers names a channel main actually handles", () => {
  // A removeHandler naming the wrong channel leaves registerFileHandlers'
  // dialog live during a smoke or preview run, which then hangs on it.
  const removed = captures(/ipcMain\.removeHandler\("([^"]+)"\)/g, MAIN);
  expect(removed.toSorted()).toEqual(["file:open", "file:pick-save"]);
  expect(removed.filter((c) => !MAIN_HANDLES.has(c))).toEqual([]);
});

// ------------------------------------------------------------- smoke checks

// Scanned as a directory, so a check added in a new file is still read.
const SMOKE_DIR = join(SRC, "main/smoke");
const SMOKE_SEND_CHANNELS = new Set(
  readdirSync(SMOKE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) =>
      captures(/send:\s*\[\s*"([^"]+)"/g, readFileSync(join(SMOKE_DIR, name), "utf8")),
    ),
);

test("smoke's own checks still have send: fields for this file to scan", () => {
  expect(SMOKE_SEND_CHANNELS.size).toBe(5);
});

test("every channel a smoke check sends through its send field is one preload listens for", () => {
  // A send is heard only on a channel preload listens for.
  const unheard = [...SMOKE_SEND_CHANNELS].filter((c) => !PRELOAD_LISTENS.has(c));
  expect(unheard).toEqual([]);
});
