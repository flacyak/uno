// The IPC bridge's own footing.
//
// Every channel name in src/preload and src/main is a plain string: nothing
// type-checks them, so a rename on one side of contextBridge and not the
// other breaks the app at runtime, and only a running Electron -- a display,
// Xvfb, a utility process -- catches it. This asks the same question without
// any of that, the way opens.test.ts and smoke.test.ts already read source
// text and assert over it rather than over a running app.
//
// What this does NOT ask: whether preload implements Bridge correctly.
// `const bridge: Bridge = { ... }` in src/preload/index.ts already makes the
// compiler prove every method exists with the right signature. What no type
// reaches is the string literals themselves, and whether main registers a
// handler or a listener for each one -- so that is the whole of what is here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const PRELOAD = readFileSync(join(SRC, "preload/index.ts"), "utf8");
const MAIN = readFileSync(join(SRC, "main/index.ts"), "utf8");
const RENDERER_MAIN = readFileSync(join(SRC, "renderer/main.ts"), "utf8");

/** Every match of a pattern with one capture group, in source order, duplicates
 * kept -- callers that need a set dedupe themselves. */
function captures(re: RegExp, src: string): string[] {
  return [...src.matchAll(re)].map((m) => {
    const group = m[1];
    if (group === undefined) throw new Error(`${re.source} matched without capturing`);
    return group;
  });
}

/** A pattern expected to match exactly once. Throwing rather than returning
 * undefined means a rewritten source fails the whole file loudly instead of
 * quietly making every assertion built on the result vacuously true. */
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

// Every ipcRenderer.invoke/send in preload, wherever it is exposed from --
// `bridge` and `unoMenu` both carry renderer -> main traffic; input:chosen
// lives on the latter.
const PRELOAD_SENDS = new Set(captures(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g, PRELOAD));

// Every ipcMain.handle/on in main. ipcMain.removeHandler does not match --
// "removeHandler" is neither "handle" nor "on" -- so the driven branch's swap
// of file:pick-save is not double-counted here.
const MAIN_HANDLES = new Set(captures(/ipcMain\.(?:handle|on)\("([^"]+)"/g, MAIN));

test("the renderer -> main extraction found the six channels this file assumes", () => {
  // Non-empty and sized on purpose: a regex that stops matching would
  // otherwise leave every "is it registered" assertion below trivially true.
  expect(PRELOAD_SENDS.size).toBe(6);
  expect(MAIN_HANDLES.size).toBe(6);
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

// buildMenu never writes webContents.send("menu:open", ...) directly. Two
// local helpers sit in front of it: `send(channel)` is a click handler built
// per literal channel below, and `pick(name)` always sends the one fixed
// channel "menu:input", with `name` going along as a payload rather than a
// channel of its own. A regex hunting only literal webContents.send("...")
// calls finds engine:port (via postMessage), menu:open-path and
// menu:add-paths (registerFileHandlers' direct sends), and menu:input (from
// inside pick's own definition) -- but not the five sent through `send`,
// which would wrongly read as orphaned. So both shapes are read together.
const MAIN_SENDS = new Set([
  ...captures(/(?:webContents\.send|sender\.postMessage)\("([^"]+)"/g, MAIN),
  ...captures(/\bsend\("([^"]+)"\)/g, MAIN),
]);

// unoMenu.on's own parameter is named `channel`, not a literal, so its five
// channels exist nowhere but the union type it is declared with -- there is
// no ipcRenderer.on("menu:open", ...) to find literally.
const PRELOAD_MENU_UNION = unionMembers(
  requireOne(/on\(\s*channel:\s*([^,]+),/, PRELOAD, "unoMenu.on's channel union"),
);

const PRELOAD_LISTENS = new Set([
  ...captures(/ipcRenderer\.on\("([^"]+)"/g, PRELOAD),
  ...PRELOAD_MENU_UNION,
]);

test("the main -> renderer extraction found the nine channels this file assumes", () => {
  expect(MAIN_SENDS.size).toBe(9);
  expect(PRELOAD_LISTENS.size).toBe(9);
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
  requireOne(/type MenuChannel = ([^;]+);/, RENDERER_MAIN, "MenuChannel"),
);

test("MenuChannel in the renderer names the same five channels as preload's union", () => {
  expect(RENDERER_MENU_UNION.length).toBe(5);
  expect(PRELOAD_MENU_UNION.length).toBe(5);
  expect([...RENDERER_MENU_UNION].sort()).toEqual([...PRELOAD_MENU_UNION].sort());
});

// ---------------------------------------------------------- file:pick-save

test("the driven branch's removeHandler names a channel main actually handles", () => {
  // A typo here leaves registerFileHandlers' dialog.showSaveDialog live during
  // a smoke or preview run. Nobody at a driven window can answer that dialog,
  // so the run hangs on it until its deadline kills it, and the failure would
  // say nothing about a renamed channel.
  const removed = requireOne(
    /ipcMain\.removeHandler\("([^"]+)"\)/,
    MAIN,
    "the driven branch's removeHandler",
  );
  expect(MAIN_HANDLES.has(removed)).toBe(true);
});

// ------------------------------------------------------------- smoke checks

// Scanned as a directory, the way opens.test.ts walks src, rather than by
// naming sources.ts and vim-style.ts -- a check added to a new file still
// gets read.
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
  // A check aimed at a channel nobody receives does nothing and fails in a way
  // that says nothing about why -- the renderer never hears the send, so
  // whatever the check looks for afterwards just never happens.
  const unheard = [...SMOKE_SEND_CHANNELS].filter((c) => !PRELOAD_LISTENS.has(c));
  expect(unheard).toEqual([]);
});
