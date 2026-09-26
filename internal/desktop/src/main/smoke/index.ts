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

import { through } from "../driven.ts";
import type { Check } from "./check.ts";
import { DEFAULT_INPUT } from "./default.ts";
import { electronPage } from "./electron-page.ts";
import { COMMAS_LEFT, DATE, DOM_ROWS, GUTTER, REGION, REP, ROWS, UNITS } from "./fixture.ts";
import { OPEN } from "./open.ts";
import { SOURCES } from "./sources.ts";
import { VIM_STYLE } from "./vim-style.ts";

/** How long the first rows get to arrive from the engine: tries, and the wait between them. */
const DRAW_TRIES = 120;
const DRAW_MS = 50;

/**
 * What a person would look at to decide the app works.
 *
 * Each one is a claim about the real fixture: 4,812 rows of a real export, the
 * units column wearing thousands separators, and a grid that must not put all
 * of it in the DOM.
 *
 * They run in order, and each picks up the window where the one before left it.
 */
const CHECKS: Check[] = [...OPEN, ...DEFAULT_INPUT, ...VIM_STYLE, ...SOURCES];

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
  // moment later.
  await win.webContents.executeJavaScript(`
    (async () => {
      for (let i = 0; i < ${DRAW_TRIES}; i++) {
        if (document.querySelector("tbody tr:not(.pending)") !== null) return;
        await new Promise((r) => setTimeout(r, ${DRAW_MS}));
      }
      throw new Error("no rows were ever drawn");
    })()
  `);

  // The input strategy outlives the window. A run stopped partway through the
  // vim-style checks would leave the next one reading keys the vim way, so every
  // run starts from the default.
  win.webContents.send("menu:input", "default");

  for (const check of CHECKS) {
    try {
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
  const shotDir = process.env["UNO_SMOKE"];
  if (shotDir !== undefined && shotDir !== "") {
    const image = await win.webContents.capturePage();
    const path = join(shotDir, "window.png");
    await writeFile(path, image.toPNG());
    console.log(`smoke: screenshot ${path}`);
  }

  if (failed === 0) console.log("smoke: all checks passed");
  else console.error(`smoke: ${failed} check(s) failed`);

  quit(failed === 0 ? 0 : 1);
}
