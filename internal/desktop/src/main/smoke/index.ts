// The assertions the smoke test makes against a running window.
//
// This is test code living in the app, which is a smell worth naming: it is
// here because a virtualiser, a preload bridge and an IPC round trip cannot be
// checked anywhere but inside a real Electron, and the alternative was a
// browser-automation dependency larger than the app it would be testing.
//
// It is reached only when UNO_SMOKE is set in the environment, it is the only
// thing in `src/main` that knows what a test is, and nothing in the app calls
// it.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow } from "electron";

import { ask } from "../ask.ts";
import { through } from "../driven.ts";
import type { Check } from "./check.ts";
import { CONNECTIONS } from "./connections.ts";
import { DEFAULT_INPUT } from "./default.ts";
import { electronPage } from "./electron-page.ts";
import { COMMAS_LEFT, DATE, DOM_ROWS, GUTTER, REGION, REP, ROWS, UNITS } from "./fixture.ts";
import { MEETS } from "./meets.ts";
import { MULTI } from "./multi.ts";
import { OPEN } from "./open.ts";
import { PANEL } from "./panel.ts";
import { REFRESH } from "./refresh.ts";
import { SETTINGS } from "./settings.ts";
import { SIDEBAR } from "./sidebar.ts";
import { SOURCES } from "./sources.ts";
import { VIM_STYLE } from "./vim-style.ts";

/**
 * How long the first rows get to arrive from the engine, and how often the
 * page is asked whether they have.
 *
 * A third of the 60 s smoke.js gives the whole run. A warm machine draws in
 * well under a second, but a CI runner starting Electron for the first time
 * has taken most of six, and a budget that close to what it needs fails on a
 * slow morning rather than on a broken app.
 */
const FIRST_ROWS_MS = 20_000;
const POLL_MS = 50;

/**
 * What a person would look at to decide the app works.
 *
 * Each one is a claim about the real fixture: 4,812 rows of a real export, the
 * units column wearing thousands separators, and a grid that must not put all
 * of it in the DOM.
 *
 * They run in order, and each picks up the window where the one before left it.
 */
const CHECKS: Check[] = [
  ...OPEN,
  ...DEFAULT_INPUT,
  ...VIM_STYLE,
  ...SOURCES,
  ...PANEL,
  ...CONNECTIONS,
  ...SETTINGS,
  ...MEETS,
  ...REFRESH,
  ...MULTI,
  ...SIDEBAR,
];

/**
 * What every check that is still a string can call. A check's body runs in a
 * block of its own, so one that declares its own `frame` shadows this one
 * rather than colliding with it.
 *
 * The fixture's own facts -- ROWS, DATE and the rest -- live in fixture.ts, so
 * a check that has become a function and one that is still a string read the
 * same values under the same names.
 */
const PRELUDE = `
  // The fixture: date,region,rep,channel,units,revenue. A body row has the
  // gutter before those, so a column's cell is one further along.
  const ROWS = ${ROWS};
  const DATE = ${DATE}, REGION = ${REGION}, REP = ${REP}, UNITS = ${UNITS};
  const GUTTER = ${GUTTER};
  // What remove commas changes once rows 1, 3 and 5 of units are fixed by hand.
  const COMMAS_LEFT = ${COMMAS_LEFT};

  // More rows than this in the DOM means the grid is not virtualising.
  const DOM_ROWS = ${DOM_ROWS};

  // How long a check waits on the app: this many frames, or polls POLL_MS apart.
  const TRIES = 150;
  const POLL_MS = 20;
  // Frames for input sent before a check to have landed, had it reached the page.
  const SETTLE_FRAMES = 10;

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const text = (selector) => document.querySelector(selector)?.textContent ?? "";
  // A key goes where a real one would: to the editor while it is open, to the
  // grid otherwise.
  const press = async (key, init = {}) => {
    const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    await frame();
  };
  const until = async (ok) => {
    for (let i = 0; i < TRIES && !ok(); i++) await frame();
    return ok();
  };
`;

/**
 * How long a shot waits after the page's frames for the compositor to put the
 * last of them on screen. Two animation frames say the page has drawn its
 * change; they do not say the window has, and capturePage returns whatever the
 * window last showed. Without this, one shot in four of a theme changed a
 * moment before came back as the frame before it.
 */
const COMPOSITED_MS = 120;

/**
 * shoot writes a picture of the window into the run's folder, as <name>.png,
 * once the check's last change is drawn and composited.
 */
async function shoot(win: BrowserWindow, name: string): Promise<void> {
  const dir = process.env["UNO_SMOKE"];
  if (dir === undefined || dir === "") return;
  await win.webContents.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
  await new Promise((r) => setTimeout(r, COMPOSITED_MS));
  const image = await win.webContents.capturePage();
  const path = join(dir, `${name}.png`);
  await writeFile(path, image.toPNG());
  console.log(`smoke: screenshot ${path}`);
}

/**
 * run drives the window, reports to stdout, and quits with a status the shell
 * can read.
 *
 * A check with `run` is called with a `Page` over this window. One still
 * carrying `script` is evaluated in the renderer as an async function body, so
 * it can wait a frame for the virtualiser to catch up -- which several of them
 * have to.
 */
export async function runSmoke(win: BrowserWindow, quit: (code: number) => void): Promise<void> {
  let failed = 0;
  const page = electronPage(win);

  // The window has loaded, but the fixture's first rows come from an engine a
  // moment later. How long that took is said, so a slow start is a number in
  // the log rather than a guess; one that never comes fails now, saying what
  // the window showed instead, rather than leaving the run to its deadline.
  const drawn = (await win.webContents.executeJavaScript(`
    (async () => {
      const start = performance.now();
      while (performance.now() - start < ${FIRST_ROWS_MS}) {
        if (document.querySelector("tbody tr:not(.pending)") !== null) {
          return { ms: Math.round(performance.now() - start) };
        }
        await new Promise((r) => setTimeout(r, ${POLL_MS}));
      }
      const text = (s) => document.querySelector(s)?.textContent ?? "";
      return { showing: [text("#status-file"), text("#status-msg")].filter((t) => t !== "").join(" · ") };
    })()
  `)) as { ms: number } | { showing: string };
  if (!("ms" in drawn)) {
    console.error(
      `  FAIL no rows were drawn within ${FIRST_ROWS_MS / 1000}s · the window shows ${JSON.stringify(drawn.showing)}`,
    );
    console.error("smoke: 1 check(s) failed");
    quit(1);
    return;
  }
  console.log(`smoke: first rows drawn ${(drawn.ms / 1000).toFixed(1)}s after the window loaded`);

  // The input strategy outlives the window. A run stopped partway through the
  // vim-style checks would leave the next one reading keys the vim way, so every
  // run starts from the default.
  win.webContents.send("menu:input", "default");

  for (const check of CHECKS) {
    try {
      if (check.ask !== undefined) await ask("smoke", check.ask);
      if (check.send !== undefined) win.webContents.send(...check.send);
      if (check.input !== undefined) {
        const { events } = check.input;
        const send = (): void => {
          for (const event of events) win.webContents.sendInputEvent(event);
        };
        if (check.input.through) through(win, send);
        else send();
      }
      const failure =
        check.run !== undefined
          ? await check.run(page)
          : ((await win.webContents.executeJavaScript(
              `(async () => { ${PRELUDE} { ${check.script} } })()`,
            )) as string);

      if (failure === "") {
        console.log(`  ok   ${check.name}`);
        if (check.shot !== undefined) await shoot(win, check.shot);
      } else {
        console.error(`  FAIL ${check.name}: ${failure}`);
        failed++;
      }
    } catch (err) {
      console.error(`  FAIL ${check.name}: ${(err as Error).message}`);
      failed++;
    }
  }

  // A picture of the window, because a list of green ticks does not show
  // whether the thing is laid out like the design says.
  await shoot(win, "window");

  if (failed === 0) console.log("smoke: all checks passed");
  else console.error(`smoke: ${failed} check(s) failed`);

  quit(failed === 0 ? 0 : 1);
}
