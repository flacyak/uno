/**
 * @fileoverview The checks the smoke test runs against a window.
 *
 * This is test code inside the app. It is reached only when UNO_SMOKE is set
 * in the environment, from main's index.ts.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BrowserWindow } from "electron";

import { ask } from "@main/ask";
import { pick, through, throughAsync } from "@main/driven";
import { AGAIN } from "./again.ts";
import { CHART_EDITS } from "./chart-edits.ts";
import { CHART_FORM } from "./chart-form.ts";
import { CHART_KEYS } from "./chart-keys.ts";
import { CHART_MOVES } from "./chart-moves.ts";
import { CHART_TIP } from "./chart-tip.ts";
import { CHART_TABLE, CHART_WHEEL } from "./chart-wheel.ts";
import {
  CHARTS,
  CHART_ALONG,
  CHART_PIE,
  CHART_SCATTER,
  CHART_SIGNED,
  CHART_STATES,
} from "./charts.ts";
import type { Check } from "./check.ts";
import { CONNECTIONS } from "./connections.ts";
import { DEFAULT_INPUT } from "./default.ts";
import { electronPage } from "./electron-page.ts";
import {
  BLANK_ROWS,
  COMMAS_LEFT,
  DATE,
  DOM_ROWS,
  GUTTER,
  LOCALE,
  REGION,
  REP,
  ROWS,
  UNITS,
} from "./fixture.ts";
import { MEETS } from "./meets.ts";
import { MULTI } from "./multi.ts";
import { OPEN } from "./open.ts";
import { PANEL } from "./panel.ts";
import { CHART_REFRESH, REFRESH } from "./refresh.ts";
import { CHART_SCHEDULE } from "./schedule.ts";
import { SETTINGS } from "./settings.ts";
import { SIDEBAR } from "./sidebar.ts";
import { SOURCES } from "./sources.ts";
import { VIM_STYLE } from "./vim-style.ts";

/**
 * How long the first rows get to arrive from the engine, and how often the
 * page is asked whether they have. A third of the 60 s smoke.js gives the run.
 */
const FIRST_ROWS_MS = 20_000;
const POLL_MS = 50;

/**
 * Every check, in order. Each picks up the window where the one before left
 * it.
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
  ...CHART_FORM,
  ...AGAIN,
  ...CHARTS,
  ...CHART_KEYS,
  ...CHART_MOVES,
  ...CHART_WHEEL,
  ...CHART_TIP,
  ...CHART_SIGNED,
  ...CHART_SCATTER,
  ...CHART_TABLE,
  ...CHART_ALONG,
  ...CHART_PIE,
  ...CHART_STATES,
  ...CHART_EDITS,
  ...CHART_REFRESH,
  ...CHART_SCHEDULE,
];

/**
 * What a check written as a string can call. The check's body runs in a block
 * of its own, so a name it declares shadows one here.
 *
 * The fixture's values come from fixture.ts, so string and function checks
 * read the same values under the same names.
 */
const PRELUDE = `
  // The fixture: date,region,rep,channel,units,revenue. A body row has the
  // gutter before those, so a column's cell is one further along.
  const ROWS = ${ROWS};
  const DATE = ${DATE}, REGION = ${REGION}, REP = ${REP}, UNITS = ${UNITS};
  // Rows with no units and no revenue, which a chart of either leaves out.
  const BLANK_ROWS = ${BLANK_ROWS};
  const GUTTER = ${GUTTER};
  // What remove commas changes once rows 1, 3 and 5 of units are fixed by hand.
  const COMMAS_LEFT = ${COMMAS_LEFT};

  // A virtualising grid keeps fewer rows than this in the DOM.
  const DOM_ROWS = ${DOM_ROWS};

  // A count as the app writes it on screen: 4,812.
  const counted = (n) => n.toLocaleString(${JSON.stringify(LOCALE)});

  // How long a check waits on the app: this many frames, or polls POLL_MS apart.
  const TRIES = 150;
  const POLL_MS = 20;
  // Frames to wait for input sent before a check to land.
  const SETTLE_FRAMES = 10;

  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const text = (selector) => document.querySelector(selector)?.textContent ?? "";
  // A key goes to the editor while one is open, to the grid otherwise.
  const press = async (key, init = {}) => {
    const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    await frame();
  };
  const until = async (ok) => {
    for (let i = 0; i < TRIES && !ok(); i++) await frame();
    return ok();
  };
  // A longer wait, four until budgets, for something coming over the network.
  const arrives = async (ok) => {
    for (let i = 0; i < 4; i++) if (await until(ok)) return true;
    return false;
  };
  // Whether the status bar counts this many edits.
  const edited = (n) => text("#status-file").includes(n + " edits");
  // Opens the sources panel if it is closed.
  const openPanel = async () => {
    if (document.querySelector("#panel").hidden) await press("B", { ctrlKey: true, shiftKey: true });
  };
  // The panel's lines, each with the index of the section it is under. The
  // sections are workspace, connections, browser.
  const lines = () => {
    let at = -1;
    return [...document.querySelectorAll("#panel .panel-row")].map((r) => ({
      el: r, section: r.classList.contains("head") ? ++at : at, cls: r.className,
      name: r.children[0].textContent, meta: r.children[1].textContent, title: r.title,
    }));
  };
  const WORKSPACE = 0, CONNECTIONS = 1, BROWSER = 2;
  const head = (section) => lines().find((l) => l.section === section && l.cls.includes("head"));
  // A section's entries, below its title and note.
  const named = (section) => lines().filter((l) => l.section === section && !/\\b(head|note)\\b/.test(l.cls));
  // A key pressed on the panel's list.
  const key = async (k) => {
    document.querySelector("#panel .panel-list")
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    await frame();
  };
  // The form that connects a bucket, its sign-in select, and its Save button.
  const connectForm = () => document.querySelector("#panel .panel-connect");
  const signInAs = (value) => {
    const choose = connectForm().querySelector("select");
    choose.value = value;
    choose.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const saveConnection = () =>
    [...connectForm().querySelectorAll("button")].find((b) => b.textContent === "Save connection").click();
  // The buttons under the panel's list, and the one with a label.
  const footButtons = () => [...document.querySelectorAll("#panel .panel-foot button")];
  const foot = () => footButtons().map((b) => b.textContent);
  const footButton = (label) => footButtons().find((b) => b.textContent === label);
`;

/**
 * How long a shot waits after the page's frames for the compositor to put
 * them on screen. capturePage returns what the window last showed, which can
 * be a frame behind the page.
 */
const COMPOSITED_MS = 120;

/** A script that settles once the page has drawn two frames. */
const TWO_FRAMES = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))";

/** The zoom a window opens at. */
const FULL_ZOOM = 1;

/** A window size limit of none. */
const NO_LIMIT = 0;

/**
 * shoot writes a picture of the window into the run's folder as <name>.png,
 * once the page has drawn and the compositor has caught up.
 */
async function shoot(win: BrowserWindow, name: string): Promise<void> {
  const dir = process.env["UNO_SMOKE"];
  if (dir === undefined || dir === "") return;
  await win.webContents.executeJavaScript(TWO_FRAMES);
  await sleep(COMPOSITED_MS);
  const image = await win.webContents.capturePage();
  const path = join(dir, `${name}.png`);
  await writeFile(path, image.toPNG());
  console.log(`smoke: screenshot ${path}`);
}

/**
 * reshape sets the window's zoom and size, moving the pin main holds a driven
 * window to.
 */
function reshape(win: BrowserWindow, zoom: number, width: number, height: number): void {
  win.webContents.setZoomFactor(zoom);
  win.setMinimumSize(NO_LIMIT, NO_LIMIT);
  win.setMaximumSize(NO_LIMIT, NO_LIMIT);
  win.setSize(width, height);
  win.setMinimumSize(width, height);
  win.setMaximumSize(width, height);
}

/** middle gives the middle of what `selector` picks, in whole px. */
function middle(win: BrowserWindow, selector: string): Promise<[number, number]> {
  return win.webContents.executeJavaScript(`
    (() => {
      const at = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return [at.left + at.width / 2, at.top + at.height / 2].map(Math.round);
    })()
  `) as Promise<[number, number]>;
}

/** hover moves the pointer to the middle of what `selector` picks. */
async function hover(win: BrowserWindow, selector: string): Promise<void> {
  const [x, y] = await middle(win, selector);
  through(win, () => win.webContents.sendInputEvent({ type: "mouseMove", x, y }));
}

/** click presses what `selector` picks `count` times in a row, as a person's pointer does. */
async function click(
  win: BrowserWindow,
  { selector, count = 1 }: NonNullable<Check["click"]>,
): Promise<void> {
  const [x, y] = await middle(win, selector);
  through(win, () => {
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
    }
  });
}

/** drag takes hold of what `selector` picks and carries it `by` CSS px. */
async function drag(
  win: BrowserWindow,
  { selector, by, held = false }: NonNullable<Check["drag"]>,
): Promise<void> {
  const [x, y] = await middle(win, selector);
  const to = { x: x + by.x, y: y + by.y };
  const left = { button: "left", clickCount: 1 } as const;
  through(win, () => {
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, ...left });
    win.webContents.sendInputEvent({ type: "mouseMove", ...to, modifiers: ["leftbuttondown"] });
    if (!held) win.webContents.sendInputEvent({ type: "mouseUp", ...to, ...left });
  });
}

/** touch presses a finger on what `selector` picks and carries it `by` CSS px. */
async function touch(
  win: BrowserWindow,
  { selector, by }: NonNullable<Check["touch"]>,
): Promise<void> {
  const [x, y] = await middle(win, selector);
  const send = (type: string, touchPoints: ReadonlyArray<{ x: number; y: number }>): unknown =>
    win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", { type, touchPoints });
  await throughAsync(win, async () => {
    await send("touchStart", [{ x, y }]);
    await send("touchMove", [{ x: x + by.x, y: y + by.y }]);
    await send("touchEnd", []);
  });
}

/**
 * wheel turns the wheel over what `selector` picks. The page answers it first and
 * the scroll it causes comes after, so the ignore stays lifted over two frames.
 * Electron counts a turn down as a negative delta, the other way to the page.
 */
async function wheel(
  win: BrowserWindow,
  { selector, down, modifiers = [] }: NonNullable<Check["wheel"]>,
): Promise<void> {
  const [x, y] = await middle(win, selector);
  await throughAsync(win, async () => {
    win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaY: -down, modifiers });
    await win.webContents.executeJavaScript(TWO_FRAMES);
  });
}

/**
 * runSmoke drives the window, reports to stdout, and quits with a status the
 * shell can read.
 *
 * A check with `run` is called with a `Page` over this window. One with
 * `script` is evaluated in the renderer as an async function body.
 */
export async function runSmoke(win: BrowserWindow, quit: (code: number) => void): Promise<void> {
  let failed = 0;
  const page = electronPage(win);

  // The window has loaded, but the first rows come from the engine a moment
  // later. How long that took is logged. If none come in time, the run fails
  // now, saying what the window showed instead.
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

  // Every run starts from the default input strategy.
  win.webContents.send("menu:input", "default");

  const { width: fullWidth, height } = win.getBounds();

  for (const check of CHECKS) {
    try {
      if (check.ask !== undefined) await ask("smoke", check.ask);
      if (check.send !== undefined) win.webContents.send(...check.send);
      if (check.pick !== undefined) pick(check.pick);
      if (check.window !== undefined) {
        const { zoom = FULL_ZOOM, width = fullWidth } = check.window;
        reshape(win, zoom, width, height);
      }
      if (check.input !== undefined) {
        const { events } = check.input;
        const send = (): void => {
          for (const event of events) win.webContents.sendInputEvent(event);
        };
        if (check.input.through) through(win, send);
        else send();
      }
      if (check.hover !== undefined) await hover(win, check.hover);
      if (check.click !== undefined) await click(win, check.click);
      if (check.drag !== undefined) await drag(win, check.drag);
      if (check.touch !== undefined) await touch(win, check.touch);
      if (check.wheel !== undefined) await wheel(win, check.wheel);
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

  // A picture of the whole window, for checking the layout.
  await shoot(win, "window");

  if (failed === 0) console.log("smoke: all checks passed");
  else console.error(`smoke: ${failed} check(s) failed`);

  quit(failed === 0 ? 0 : 1);
}
