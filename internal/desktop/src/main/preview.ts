// The scripted preview: the app plays one short story in its own window while
// the same process captures frames of the window.
//
// Frames are the window's client area, captured with capturePage. The script
// and the camera share one clock. The frames and a manifest of their timings
// are written to the UNO_PREVIEW directory for scripts/preview.js to encode.
//
// Runs only when UNO_PREVIEW names a directory. src/main/index.ts is its one
// caller.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow, Rectangle } from "electron";

import { ask } from "./ask.ts";
import { through } from "./driven.ts";

/**
 * Milliseconds between frame captures. Faster than the 12fps the GIF is
 * encoded at, so the encoder always has a surplus of frames.
 */
const FRAME_INTERVAL = 60;

/**
 * The default minimum number of distinct frames in a take. A take with fewer
 * is a film of a still image and fails. A story can set its own in STORIES.
 */
const MIN_DISTINCT = 8;

/**
 * The edit story's beats, in milliseconds from the moment the camera starts.
 * All story timelines are absolute offsets, so a slow step eats into the hold
 * after it and the beats that follow stay where they are.
 */
const BEAT = {
  transform: 1_600, // Ctrl+E, from view to transform
  fix1: 2_500, // the first of three corrections
  fix2: 5_000,
  fix3: 7_000,
  apply: 9_700, // Apply in the banner
  toEnd: 11_400, // scroll to the last row
  toHome: 13_200, // jump back to the top
  end: 15_600,
};

/**
 * The browse story's beats: a workspace whose export was renamed is re-pointed
 * from the sources panel, a second export is added, and the themes are tried
 * from the settings menu.
 *
 * scripts/preview.js lays the folder out as 2024/, google-ads.csv,
 * q3-close.uno and sales-q3-final.csv, in that order, with
 * google-ads-2024.csv inside 2024/.
 */
const BROWSE = {
  panel: 1_600, // Ctrl+Shift+B opens the panel
  repoint: 3_400, // p on the tab's line: Re-point
  enter: 5_000, // Enter steps into 2024/
  peek: 6_200, // Space peeks at its one file
  up: 8_600, // Backspace goes back up
  walk: 9_400, // Down three times
  pick: 10_600, // Space peeks at sales-q3-final.csv
  point: 12_800, // Enter presses Point
  add: 15_200, // Up twice and Enter adds google-ads.csv
  settings: 18_400, // click the gear
  tokyo: 19_900, // themes, light then dark
  dark: 21_300,
  frappe: 22_700,
  sakura: 24_100,
  light: 25_700, // back to light so the loop joins up
  ember: 26_500,
  close: 27_900, // Escape closes the menu
  end: 29_400,
};

/**
 * The refresh story's beats: a workspace whose export in the bucket changed
 * since it was saved, the export rewritten again while it is open, and Reload
 * from the panel.
 *
 * scripts/preview.js lays it out against the stand-in bucket and rewrites the
 * object when asked.
 */
const REFRESH = {
  panel: 2_200, // Ctrl+Shift+B opens the panel
  rewrite: 4_600, // the stand-in rewrites the export
  focus: 5_600, // the window gets a focus event
  reload: 9_400, // r on the tab's line: Reload
  end: 13_400,
};

/**
 * The sidebar story's beats: a click between workspaces in the sidebar, a
 * formula inserted from a right click, a save, the sidebar folded and
 * unfolded, a new workspace from the + at its foot, and the pointer on the
 * close button.
 *
 * scripts/preview.js names the workspaces in UNO_PREVIEW_WORKSPACES. They are
 * opened in that order before the camera starts, so the take begins on the
 * last. Its export ends in an empty commission column, which the formula
 * fills.
 */
const SIDEBAR = {
  other: 1_800, // click another workspace
  back: 4_000, // click back
  column: 5_300, // click the last column
  menu: 6_200, // right click the open workspace
  formula: 7_600, // Insert formula
  typed: 8_800, // type the expression
  insert: 11_200, // Enter inserts it
  save: 13_800, // menu:save
  fold: 15_400, // fold the sidebar
  unfold: 17_000,
  plus: 18_600, // + at the foot: a new workspace
  close: 21_600, // hover the close button
  end: 23_600,
};

/** The formula the sidebar story inserts. */
const SIDEBAR_FORMULA = "revenue / 20";

/**
 * The opening story's beats: an export in a slow bucket is added from the
 * sources panel, and its line in the panel shows it opening.
 *
 * scripts/preview.js lays it out against the stand-in bucket and sets the
 * bucket's latency when asked.
 */
const OPENING = {
  panel: 1_500, // Ctrl+Shift+B opens the panel
  connection: 2_700, // Down to the connection
  browse: 3_400, // Enter browses it
  slow: 4_600, // the stand-in is made slow
  add: 5_200, // Enter adds the first export
  end: 13_400,
};

/** The stand-in's latency per answer, in ms, while the opening story adds. */
const OPENING_LATENCY_MS = 1_100;

/**
 * The connecting story's beats: a slow bucket is connected from the sources
 * panel, and its line in the panel shows it connecting.
 *
 * scripts/preview.js lays it out like the opening story, with the connection
 * left out for the story to save.
 */
const CONNECTING = {
  panel: 1_500, // Ctrl+Shift+B opens the panel
  line: 2_500, // Down to the Connect a bucket line
  form: 3_200, // Enter opens the form
  bucket: 4_000, // type the bucket
  prefix: 5_900, // Tab, then type the prefix
  slow: 7_000, // the stand-in is made slow
  save: 7_400, // click Save connection
  end: 14_400,
};

/** The bucket and prefix the connecting story types. The stand-in holds them. */
const CONNECTING_BUCKET = "acme-exports";
const CONNECTING_PREFIX = "2025";

/**
 * The refused story: the connecting story with the bucket's name mistyped.
 * The connection fails, and Enter on its line reopens the form.
 */
const REFUSED_BUCKET = "acme-exprots";
const REFUSED = {
  edit: 12_600, // Enter on the failed line edits it
  end: 15_400,
};
/**
 * The stand-in's latency per answer, in ms, while the connecting story saves.
 * A connection test is two requests where an open is four, so this is higher
 * to keep the line up as long.
 */
const CONNECTING_LATENCY_MS = 1_800;
/** The poll interval and poll count arrived() uses. */
const ARRIVED_MS = 50;
const ARRIVED_LOOKS = 160;

/** The stand-in key of the object the refresh story's workspace points at. */
const REFRESH_KEY = "2025/ads-q3.csv";

/** The pauses inside one correction, in milliseconds. */
const ARROW_GAP = 180; // between arrow presses
const OPEN_PAUSE = 460; // between arriving at a cell and typing into it
const KEYSTROKE = 110; // between typed characters
const PRE_ENTER = 300; // before Enter commits a value

/**
 * How long the scroll to the end takes, in ms. Kept short: every frame of a
 * scroll changes every pixel, which is what makes a GIF large.
 */
const SCROLL_END = 300;

/**
 * The size the preview is filmed at: the window size index.ts asks for, and
 * the size the design documents in resource/ are drawn at. If the window
 * manager gives another size, settle warns and films at that size.
 */
const WANT_WIDTH = 1100;
const WANT_HEIGHT = 720;

/**
 * The edit story's three corrections. Rows 1, 3 and 5 of sales-q3.csv hold
 * 1,204, 1,455 and 2,038 in `units`, column 4. The grid selects (0,0) when a
 * sheet is shown, so `right` and `down` are arrow presses from the previous
 * position.
 */
const FIXES = [
  { right: 4, down: 0, value: "1204" },
  { right: 0, down: 2, value: "1455" },
  { right: 0, down: 2, value: "2038" },
];

/** One captured frame: its file name and its offset into the recording. */
interface Shot {
  file: string;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * runPreview waits for the page to be ready, plays the story named by
 * UNO_PREVIEW_STORY while capturing frames, writes the frames and
 * frames.json to the UNO_PREVIEW directory, and quits with an exit code.
 */
export async function runPreview(win: BrowserWindow, quit: (code: number) => void): Promise<void> {
  const dir = process.env["UNO_PREVIEW"];
  if (dir === undefined || dir === "") {
    console.error("preview: UNO_PREVIEW must name a directory for the frames");
    quit(2);
    return;
  }
  await mkdir(dir, { recursive: true });

  // A capture taken before the window is shown comes back blank.
  for (let i = 0; i < 100 && !win.isVisible(); i++) await sleep(50);

  // Wait for the engine's data to be drawn. Most stories wait for rows. A
  // story with `ready: "trouble"` opens a workspace whose source is missing,
  // so it waits for the tab's trouble mark instead.
  const story = process.env["UNO_PREVIEW_STORY"] ?? "edit";
  const {
    end,
    script,
    ready = "rows",
    minDistinct = MIN_DISTINCT,
  } = STORIES[story] ?? STORIES["edit"]!;
  const drawn = ready === "rows" ? "tbody tr:not(.pending)" : ".tab .trouble";
  try {
    // The sidebar story opens its workspaces first; the last has rows.
    if (story === "sidebar") await openWorkspaces(win);
    const shown = `document.querySelector(${JSON.stringify(drawn)}) !== null`;
    await waitIn(win, shown, `nothing was ever drawn at ${drawn}`);
  } catch (err) {
    console.error(`preview: ${(err as Error).message}`);
    quit(1);
    return;
  }

  const rect = await settle(win);

  // The camera and the script share this clock.
  const start = Date.now();
  const at: Clock = (ms) => sleep(start + ms - Date.now());
  // Stories are written for the default key mode.
  win.webContents.send("menu:input", "default");
  let shots: (Shot & { hash: string })[];
  try {
    [shots] = await Promise.all([film(win, dir, rect, start, end), script(win, at)]);
  } catch (err) {
    console.error(`preview: FAILED -- ${(err as Error).message}`);
    quit(1);
    return;
  }

  // frames.json carries each frame's real timing to the encoder.
  const total = Date.now() - start;
  await writeFile(
    join(dir, "frames.json"),
    JSON.stringify({ total, frames: shots.map(({ file, at }) => ({ file, at })) }, null, 2),
  );

  const distinct = new Set(shots.map((s) => s.hash)).size;
  const fps = (shots.length / (total / 1000)).toFixed(1);
  console.log(`preview: ${shots.length} frames over ${(total / 1000).toFixed(1)}s (${fps}/s)`);
  console.log(`preview: ${distinct} distinct`);

  if (distinct < minDistinct) {
    console.error(`preview: FAILED -- ${distinct} distinct frames is a film of a still image`);
    quit(1);
    return;
  }
  console.log("preview: rolled");
  quit(0);
}

/** How often stopped reads the window's size, in ms, and the most reads it takes. */
const SETTLE_MS = 100;
const SETTLE_READS = 60;
/** How many reads in a row must agree before the size counts as stopped. */
const STABLE_READS = 6;

/**
 * How many times settle asks for the size and measures the result. A
 * frameless window under Wayland comes up larger than asked by a fixed margin,
 * so the second ask subtracts that margin.
 */
const SHAPE_TRIES = 3;

/**
 * settle sizes the window to WANT_WIDTH x WANT_HEIGHT, waits for it to stop
 * resizing, and returns the rectangle every frame is captured from.
 *
 * The size is measured once and passed to every capture. A frame of a
 * different size makes the GIF encoder write every frame in full.
 */
async function settle(win: BrowserWindow): Promise<Rectangle> {
  // Ask for the size, measure what came back, and subtract the difference
  // from the next ask.
  let width = WANT_WIDTH;
  let height = WANT_HEIGHT;
  let got = { width: 0, height: 0 };
  for (let i = 0; i < SHAPE_TRIES; i++) {
    win.setMinimumSize(width, height);
    win.setMaximumSize(width, height);
    win.setContentSize(width, height);
    await stopped(win);

    got = (await win.webContents.capturePage()).getSize();
    if (got.width === WANT_WIDTH && got.height === WANT_HEIGHT) break;
    width -= got.width - WANT_WIDTH;
    height -= got.height - WANT_HEIGHT;
  }

  if (got.width !== WANT_WIDTH || got.height !== WANT_HEIGHT) {
    console.warn(
      `preview: filming at ${got.width}x${got.height}, not ${WANT_WIDTH}x${WANT_HEIGHT} --` +
        " the window manager placed the window. Float it for a take that matches the design.",
    );
  }
  return { x: 0, y: 0, ...got };
}

/**
 * stopped waits until the window's content size has been the same for
 * STABLE_READS reads in a row, or SETTLE_READS reads have passed. A tiling
 * window manager can change the size a few hundred milliseconds after it was
 * set.
 */
async function stopped(win: BrowserWindow): Promise<void> {
  let last = "";
  let same = 0;
  for (let i = 0; i < SETTLE_READS && same < STABLE_READS; i++) {
    const [w, h] = win.getContentSize();
    const now = `${w}x${h}`;
    same = now === last ? same + 1 : 0;
    last = now;
    await sleep(SETTLE_MS);
  }
}

/**
 * film captures the window every FRAME_INTERVAL ms until `end` ms after
 * `start`, writes each frame as a PNG in dir, and returns the frames with
 * their real capture times and content hashes.
 *
 * Writes are queued, so the capture cadence is bounded by the capture alone.
 * All writes are awaited together before returning.
 */
async function film(
  win: BrowserWindow,
  dir: string,
  rect: Rectangle,
  start: number,
  end: number,
): Promise<(Shot & { hash: string })[]> {
  const shots: (Shot & { hash: string })[] = [];
  const writes: Promise<void>[] = [];

  for (let i = 0; ; i++) {
    const at = Date.now() - start;
    if (at >= end) break;

    const image = await win.webContents.capturePage(rect);
    const { width, height } = image.getSize();
    if (width !== rect.width || height !== rect.height) {
      // One frame of a different size makes the GIF encoder write every
      // frame in full.
      throw new Error(`frame ${i} came back ${width}x${height}, not ${rect.width}x${rect.height}`);
    }
    const png = image.toPNG();
    const file = `frame-${String(i).padStart(5, "0")}.png`;

    shots.push({ file, at, hash: createHash("sha256").update(png).digest("hex") });
    writes.push(writeFile(join(dir, file), png));

    await sleep(FRAME_INTERVAL - (Date.now() - start - at));
  }

  await Promise.all(writes);
  return shots;
}

/**
 * play performs the edit story: Ctrl+E into transform mode, three cells
 * corrected from the keyboard, Apply clicked in the banner, a scroll to the
 * end of the file, and a jump back to the top.
 *
 * Keys and clicks go through sendInputEvent inside `through`, so they land
 * as real input events while the window ignores the desktop.
 */
async function play(win: BrowserWindow, at: Clock): Promise<void> {
  // The file opens in view mode, where a writing key only shows a message.
  await at(BEAT.transform);
  press(win, "E", ["control"]);

  // Three corrections: arrows to the cell, the value typed, Enter.
  for (const [i, beat] of [BEAT.fix1, BEAT.fix2, BEAT.fix3].entries()) {
    await at(beat);
    await fix(win, FIXES[i]!);
  }

  // Apply the banner's offer to correct the rest of the column.
  await at(BEAT.apply);
  await click(win, "#banner button.primary");

  // An eased scroll to the end, then a jump back to the top.
  await at(BEAT.toEnd);
  await scroll(win, "end", SCROLL_END);

  await at(BEAT.toHome);
  await scroll(win, "home", 0);

  // Hold on the final state until the take ends.
  await at(BEAT.end);
}

/**
 * playBrowse performs the browse story: the panel opened, the missing file's
 * folder browsed from the keyboard, the right file pointed at, the other
 * export added, then the themes tried from the settings menu with the
 * pointer.
 *
 * Every key after Ctrl+Shift+B lands on the panel's list until the last
 * Enter adds a tab and focus returns to the grid.
 */
async function playBrowse(win: BrowserWindow, at: Clock): Promise<void> {
  await at(BROWSE.panel);
  press(win, "B", ["control", "shift"]);

  // The panel opens with the keys on the tab's line. p is Re-point.
  await at(BROWSE.repoint);
  press(win, "p");

  await at(BROWSE.enter);
  press(win, "Return");
  await at(BROWSE.peek);
  press(win, "Space");
  await at(BROWSE.up);
  press(win, "Backspace");

  await at(BROWSE.walk);
  await presses(win, "Down", 3, ARROW_GAP * 2);
  await at(BROWSE.pick);
  press(win, "Space");

  // Enter with a file peeked presses the button under it: Point here.
  await at(BROWSE.point);
  press(win, "Return");

  await at(BROWSE.add);
  await presses(win, "Up", 2, ARROW_GAP * 2);
  await sleep(OPEN_PAUSE);
  press(win, "Return");

  // Open settings from the gear and click through the themes, ending on the
  // one the take began in.
  await at(BROWSE.settings);
  await click(win, "#settings");
  await at(BROWSE.tokyo);
  await click(win, '.settings [data-theme="tokyo-night"]');
  await at(BROWSE.dark);
  await click(win, '.settings [data-appearance="dark"]');
  await at(BROWSE.frappe);
  await click(win, '.settings [data-theme="catppuccin-frappe"]');
  await at(BROWSE.sakura);
  await click(win, '.settings [data-theme="sakura"]');
  await at(BROWSE.light);
  await click(win, '.settings [data-appearance="light"]');
  await at(BROWSE.ember);
  await click(win, '.settings [data-theme="paper-ember"]');
  await at(BROWSE.close);
  press(win, "Escape");

  await at(BROWSE.end);
}

/**
 * playRefresh performs the refresh story: the panel opened on the changed
 * tab, the export rewritten in the bucket by the script, a focus event
 * dispatched to the page so it checks the bucket again, and r on the tab's
 * line to reload.
 *
 * The driven window always reports itself focused, so the focus event is
 * dispatched by script.
 */
async function playRefresh(win: BrowserWindow, at: Clock): Promise<void> {
  await at(REFRESH.panel);
  press(win, "B", ["control", "shift"]);

  await at(REFRESH.rewrite);
  await ask("preview", `rewrite ${REFRESH_KEY}`);

  await at(REFRESH.focus);
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("focus"))`);

  // The panel opens with the keys on the tab's line. r is Reload.
  await at(REFRESH.reload);
  press(win, "r");

  await at(REFRESH.end);
}

/**
 * openWorkspaces opens each path in UNO_PREVIEW_WORKSPACES, in order, and
 * waits for each to become the open workspace. Opening a workspace is what
 * lists it in the sidebar.
 */
async function openWorkspaces(win: BrowserWindow): Promise<void> {
  const paths = JSON.parse(process.env["UNO_PREVIEW_WORKSPACES"] ?? "[]") as string[];
  for (const path of paths) {
    win.webContents.send("menu:open-path", path);
    const open = `document.querySelector(".ws.open")?.dataset.path === ${JSON.stringify(path)}`;
    await waitIn(win, open, `${path} never opened`);
  }
}

/**
 * waitIn polls the page for `condition`, a JavaScript expression, for six
 * seconds, and throws `failure` when the time runs out first.
 */
async function waitIn(win: BrowserWindow, condition: string, failure: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    (async () => {
      for (let i = 0; i < 120; i++) {
        if (${condition}) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(${JSON.stringify(failure)});
    })()
  `);
}

/**
 * playSidebar performs the sidebar story with the pointer: a click on another
 * workspace and back, a right click for the formula form, the expression
 * typed and entered, a save, the sidebar folded and unfolded, the + at its
 * foot, and a hover on the close button.
 */
async function playSidebar(win: BrowserWindow, at: Clock): Promise<void> {
  // The sidebar lists other workspaces most recent first. Clicking the first
  // of them twice goes to it and back.
  await at(SIDEBAR.other);
  await click(win, ".ws:not(.open)");
  await at(SIDEBAR.back);
  await click(win, ".ws:not(.open)");

  // The formula form opens on the selected column, so select the empty one.
  await at(SIDEBAR.column);
  await click(win, "tbody tr:first-child td:last-child");

  await at(SIDEBAR.menu);
  await click(win, ".ws.open", "right");
  await at(SIDEBAR.formula);
  await click(win, ".pop-menu .pop-item");

  // The form opens with focus in the expression field.
  await at(SIDEBAR.typed);
  for (const ch of SIDEBAR_FORMULA) {
    through(win, () => win.webContents.sendInputEvent({ type: "char", keyCode: ch }));
    await sleep(KEYSTROKE);
  }
  await at(SIDEBAR.insert);
  press(win, "Return");

  // Ctrl+S is a menu accelerator handled in main, so send the menu message.
  await at(SIDEBAR.save);
  win.webContents.send("menu:save");

  await at(SIDEBAR.fold);
  await click(win, "#sidebar-toggle");
  await at(SIDEBAR.unfold);
  await click(win, "#sidebar-toggle");

  // The + asks the open dialog, which smoke/pick.ts answers from the
  // environment.
  await at(SIDEBAR.plus);
  await click(win, "#new");

  // Hover the close button.
  await at(SIDEBAR.close);
  await hover(win, "#close");

  await at(SIDEBAR.end);
}

/** Clock waits until the given offset, in ms, from the moment the camera started. */
type Clock = (ms: number) => Promise<void>;

/**
 * A story: when it ends, the function that plays it, what must be drawn
 * before the camera starts (rows by default, or the tab's trouble mark), and
 * its minimum distinct frame count (MIN_DISTINCT by default).
 */
interface Story {
  end: number;
  script: (win: BrowserWindow, at: Clock) => Promise<void>;
  ready?: "rows" | "trouble";
  minDistinct?: number;
}

const STORIES: Record<string, Story> = {
  edit: { end: BEAT.end, script: play },
  browse: { end: BROWSE.end, script: playBrowse, ready: "trouble" },
  refresh: { end: REFRESH.end, script: playRefresh, ready: "trouble", minDistinct: 4 },
  sidebar: { end: SIDEBAR.end, script: playSidebar },
  opening: { end: OPENING.end, script: playOpening },
  connecting: { end: CONNECTING.end, script: playConnecting },
  refused: { end: REFUSED.end, script: playRefused },
};

/**
 * playOpening performs the opening story: the panel opened, the bucket's
 * connection browsed, the stand-in made slow, and the first export added
 * with Enter so its line in the panel is seen opening before its tab
 * arrives.
 */
async function playOpening(win: BrowserWindow, at: Clock): Promise<void> {
  await at(OPENING.panel);
  press(win, "B", ["control", "shift"]);

  // There is one tab, so one line down is the connection.
  await at(OPENING.connection);
  press(win, "Down");
  await at(OPENING.browse);
  press(win, "Return");

  // Make the stand-in slow before the export is added.
  await at(OPENING.slow);
  await ask("preview", `latency ${OPENING_LATENCY_MS}`);
  await at(OPENING.add);
  press(win, "Return");

  // Restore the stand-in's speed once the tab has arrived.
  await arrived(win);
  await ask("preview", "latency 0");

  await at(OPENING.end);
}

/**
 * playConnecting performs the connecting story: the connect form filled in
 * and saved while the stand-in is slow, so its line in the panel is seen
 * connecting before the bucket is browsed.
 */
async function playConnecting(win: BrowserWindow, at: Clock): Promise<void> {
  await connect(win, at, CONNECTING_BUCKET);
  await at(CONNECTING.end);
}

/**
 * playRefused performs the refused story: the connect form saved with the
 * bucket's name mistyped, and Enter on the failed line to reopen the form.
 */
async function playRefused(win: BrowserWindow, at: Clock): Promise<void> {
  await connect(win, at, REFUSED_BUCKET);
  await at(REFUSED.edit);
  press(win, "Return");
  await at(REFUSED.end);
}

/**
 * connect is the part the connecting and refused stories share: the panel
 * opened, the connect form filled in with `bucket` and CONNECTING_PREFIX,
 * the stand-in made slow, Save clicked, and a wait until the line has
 * stopped connecting, whether it succeeded or failed.
 */
async function connect(win: BrowserWindow, at: Clock, bucket: string): Promise<void> {
  await at(CONNECTING.panel);
  press(win, "B", ["control", "shift"]);

  // There is one tab, so one line down is Connect a bucket.
  await at(CONNECTING.line);
  press(win, "Down");
  await at(CONNECTING.form);
  press(win, "Return");

  // The form opens with focus in the bucket field. Tab moves to the prefix.
  await at(CONNECTING.bucket);
  await type(win, bucket);
  await at(CONNECTING.prefix);
  press(win, "Tab");
  await sleep(KEYSTROKE);
  await type(win, CONNECTING_PREFIX);

  // Save tests the connection first. Make the stand-in slow before it.
  await at(CONNECTING.slow);
  await ask("preview", `latency ${CONNECTING_LATENCY_MS}`);
  await at(CONNECTING.save);
  await click(win, ".panel-connect button.primary");

  await arrived(win);
  await ask("preview", "latency 0");
}

/**
 * arrived waits for a panel row with the `opening` class to appear and then
 * disappear. Gives up and throws after ARRIVED_LOOKS polls.
 */
async function arrived(win: BrowserWindow): Promise<void> {
  const gone = (await win.webContents.executeJavaScript(`
    (async () => {
      let seen = false;
      for (let i = 0; i < ${ARRIVED_LOOKS}; i++) {
        const opening = document.querySelector("#panel .panel-row.opening") !== null;
        if (seen && !opening) return true;
        seen ||= opening;
        await new Promise((r) => setTimeout(r, ${ARRIVED_MS}));
      }
      return false;
    })()
  `)) as boolean;
  if (!gone) throw new Error("no line in the panel was seen on its way and then arrived");
}

/** type sends keyDown, char and keyUp for each character, KEYSTROKE ms apart. */
async function type(win: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) {
    through(win, () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
      win.webContents.sendInputEvent({ type: "char", keyCode: ch });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch });
    });
    await sleep(KEYSTROKE);
  }
}

/** The pause, in ms, between the pointer arriving at an element and pressing. */
const HOVER = 250;

/**
 * click moves the pointer to the centre of the element matching selector,
 * waits HOVER ms, and sends a mouse down and up there. Only the position is
 * read from the page; the press is a real input event.
 */
async function click(
  win: BrowserWindow,
  selector: string,
  button: "left" | "right" = "left",
): Promise<void> {
  const { x, y } = await hover(win, selector);
  await sleep(HOVER);
  through(win, () => {
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
  });
}

/**
 * hover moves the pointer to the centre of the element matching selector and
 * returns that point.
 */
async function hover(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  // The page returns null for a missing element, and the throw happens here
  // with the selector: an error thrown in the page arrives as a bare "Script
  // failed to execute".
  const at = (await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `)) as { x: number; y: number } | null;
  if (at === null) throw new Error(`nothing to point at ${selector}`);
  const { x, y } = at;
  through(win, () => win.webContents.sendInputEvent({ type: "mouseMove", x, y }));
  return at;
}

/** fix walks to a cell with the arrows, types value over it, and presses Enter. */
async function fix(
  win: BrowserWindow,
  { right, down, value }: { right: number; down: number; value: string },
): Promise<void> {
  await presses(win, "Right", right, ARROW_GAP);
  await presses(win, "Down", down, ARROW_GAP);
  await sleep(OPEN_PAUSE);

  // The first character is sent as keyDown and keyUp only. The grid reads the
  // keyDown, opens the editor and puts the character in the field itself.
  // Sending a char event too would type it twice.
  press(win, value[0]!);
  await sleep(KEYSTROKE);

  // The rest go to the field, which needs the char event to insert anything.
  await type(win, value.slice(1));

  await sleep(PRE_ENTER);
  press(win, "Return");
}

/** press sends one keyDown and keyUp for keyCode with the given modifiers. */
function press(win: BrowserWindow, keyCode: string, modifiers: Modifier[] = []): void {
  through(win, () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  });
}

type Modifier = "control" | "shift";

/** presses presses keyCode `n` times, `gap` ms apart. */
async function presses(win: BrowserWindow, keyCode: string, n: number, gap: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    press(win, keyCode);
    await sleep(gap);
  }
}

/**
 * scroll scrolls the grid to the top or the end by script, eased over `ms`
 * milliseconds, or in one jump when `ms` is 0. A driven window drops the
 * scroll a wheel event causes (see driven.ts), so this uses a script.
 */
function scroll(win: BrowserWindow, to: "end" | "home", ms: number): Promise<void> {
  const dest = to === "end" ? "sc.scrollHeight" : "0";
  return win.webContents.executeJavaScript(`
    (async () => {
      const sc = document.querySelector(".grid-scroll");
      const from = sc.scrollTop;
      const dest = ${dest};
      if (${ms} === 0) { sc.scrollTop = dest; return; }

      const t0 = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ${ms});
          sc.scrollTop = from + (dest - from) * (1 - Math.pow(1 - p, 3));
          if (p < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    })()
  `) as Promise<void>;
}
