// The scripted preview: the app driving itself through one short story while a
// camera in the same process films it.
//
// This is the second piece of test-shaped code in `src/main`, and it is here for
// the reason `smoke/index.ts` gives for the first: a window is the only place it can
// run. The Go build filmed itself for the same reason -- it needed to choose a
// cell and type into it, and no compositor-level tool on this machine has a
// dispatcher for a pointer button.
//
// Filming from inside is what the smoke test already proved possible, and it
// buys three things the old grim rig could not have: no compositor dependency,
// frames that are exactly the window's client area rather than a screen region
// anything can wander into, and one clock shared by the script and the camera
// instead of two synchronised through a file.
//
// It is reached only when UNO_PREVIEW names a directory, and nothing in the app
// calls it.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserWindow, Rectangle } from "electron";

import { ask } from "./ask.ts";
import { through } from "./driven.ts";

/**
 * How often the camera tries for a frame.
 *
 * Faster than the 12fps the GIF is encoded at, so the encoder is resampling a
 * surplus rather than interpolating a shortfall. That is what keeps a slow grab
 * from reading as a stutter.
 */
const FRAME_INTERVAL = 60;

/**
 * The fewest distinct frames a real take of each story contains.
 *
 * Every other way this can fail is loud. A script that silently did nothing is
 * not: it yields two hundred identical frames and a perfectly valid GIF of a
 * still image, which is the one failure that would ship. The stories that type
 * and scroll change the window many times over. The refresh story changes it
 * once a beat -- the panel, the mark, the reload -- so a take of it has the
 * opening frame and one for each of those three, and a take with fewer is one
 * where a beat did nothing.
 */
const MIN_DISTINCT: Record<string, number> = { edit: 8, browse: 8, refresh: 4, sidebar: 8 };

/**
 * The edit story, as offsets from the moment the camera rolls.
 *
 * They are absolute rather than a list of gaps so the timeline can be read off
 * this file and matched against the recording, and so a slow step steals its
 * time from the following hold instead of shifting everything after it.
 */
const BEAT = {
  transform: 1_600, // the file opened in view; Ctrl+E is the decision to change it
  fix1: 2_500, // the grid and its type badges have been read by now
  fix2: 5_000,
  fix3: 7_000,
  apply: 9_700, // the three corrections have landed and the banner has been read
  toEnd: 11_400, // the column has been rewritten where it was watched
  toHome: 13_200, // row 4,812 has been up long enough to read
  end: 15_600,
};

/**
 * The browse story, in the same form: a workspace whose export was renamed,
 * found again from the sources panel, and a second export added beside it.
 *
 * scripts/preview.js lays the folder out. Browsed from the workspace, it is
 * 2024/, google-ads.csv, q3-close.uno and sales-q3-final.csv, in that order,
 * and 2024/ holds google-ads-2024.csv.
 */
const BROWSE = {
  panel: 1_600, // the ! on the tab and the empty grid have been read
  repoint: 3_400, // the panel says the file is missing, and offers Re-point
  enter: 5_000, // the folder the file was in is listed; step into 2024/
  peek: 6_200, // its one file, peeked at before anything is added
  up: 8_600, // not it: back up
  walk: 9_400, // down past the other export and the workspace itself
  pick: 10_600, // sales-q3-final.csv, peeked at, with the Point button under it
  point: 12_800, // the tab reads it, and the three fixes replay
  add: 15_200, // the other export, one Enter from being a tab
  settings: 18_400, // both exports are open; the gear in the corner
  tokyo: 19_900, // the menu has been read; a theme is worn the moment it is chosen
  dark: 21_300, // the same theme in the dark
  frappe: 22_700,
  sakura: 24_100,
  light: 25_700, // back to where the take began, so the loop joins up
  ember: 26_500,
  close: 27_900,
  end: 29_400,
};

/**
 * The refresh story, in the same form: a colleague's workspace whose export in
 * the bucket was regenerated since it was saved, then regenerated again while
 * it is open, and read again with Reload.
 *
 * scripts/preview.js lays it out against the stand-in bucket and rewrites the
 * object when the story asks it to.
 */
const REFRESH = {
  panel: 2_200, // the ! on the tab and the reason in the status bar have been read
  rewrite: 4_600, // the line says changed; somebody regenerates the export again
  focus: 5_600, // and the person comes back to the window
  reload: 9_400, // the line says newer in bucket, and the status bar says Reload reads it
  end: 13_400, // the corrected figure, and what Reload found, have been read
};

/**
 * The sidebar story, in the same form: the workspaces opened on this machine
 * in the sidebar, one click between them, a formula put into one from a right
 * click, the sidebar closed for the width and opened again, a new workspace
 * from the + at its foot, and the × that closes the window.
 *
 * scripts/preview.js lays the workspaces out and names them in
 * UNO_PREVIEW_WORKSPACES, in the order they are opened before the camera
 * rolls, so the last is the one the take begins on. Its export ends in an
 * empty commission column, which is the column the formula goes into.
 */
const SIDEBAR = {
  other: 1_800, // the list and the open workspace's source have been read
  back: 4_000, // another workspace's rows; and back, one click
  column: 5_300, // a click in the column the formula is for
  menu: 6_200, // a right click on the workspace
  formula: 7_600, // Insert formula…
  typed: 8_800, // the form is open on the selected column; the expression is typed
  insert: 11_200, // Enter, which is Insert
  save: 13_800, // the column is computed, and wears fx; Ctrl+S keeps it
  fold: 15_400, // the sidebar closed, and the grid has its width
  unfold: 17_000,
  plus: 18_600, // the + at the foot: a file as a new workspace
  close: 21_600, // it is not saved yet, and says so; the pointer goes to the ×
  end: 23_600,
};

/** What the sidebar story's formula computes the commission column from. */
const SIDEBAR_FORMULA = "revenue / 20";

/** The object the refresh story's workspace points at, by its key in the stand-in. */
const REFRESH_KEY = "2025/ads-q3.csv";

/**
 * The pacing inside one correction. Gaps, not offsets, because what matters
 * about them is the rhythm -- the three have to look like the same gesture
 * repeated.
 */
const ARROW_GAP = 180; // between arrow presses, so travel reads as travel
const OPEN_PAUSE = 460; // between arriving at a cell and typing into it
const KEYSTROKE = 110; // fast enough to read, slow enough to see
const PRE_ENTER = 300; // the pause before committing a value

/**
 * How long the scroll to the end takes.
 *
 * Short, because every frame of it is a frame in which every pixel changes, and
 * that is the only expensive thing a GIF of this app can do -- a second and a
 * half of scrolling cost more than the whole rest of the story put together.
 * Three hundred milliseconds is a whip across 4,812 rows, which is both cheap
 * and the honest shape of the claim: not that scrolling is pretty, that it is
 * instant.
 */
const SCROLL_END = 300;

/**
 * The shape the preview is filmed in, which is the shape the window asks for in
 * index.ts and the one the design documents in resource/ describe.
 *
 * A window manager is free to ignore that, and a tiling one does. The take is
 * still usable at whatever size it lands on, so this is a warning rather than a
 * refusal -- but it has to be said, because a preview quietly filmed in someone
 * else's aspect ratio is how the README ends up with the wrong picture.
 */
const WANT_WIDTH = 1100;
const WANT_HEIGHT = 720;

/**
 * The corrections.
 *
 * Rows 1, 3 and 5 of sales-q3.csv hold 1,204, 1,455 and 2,038 in `units`, which
 * is why that column is badged `text` -- the thousands separators do not parse.
 * Column 4 is `units`; the grid selects (0,0) when a sheet is shown, so `right`
 * is how far along the row the walk has to go and `down` is how far it steps
 * from the correction before it.
 */
const FIXES = [
  { right: 4, down: 0, value: "1204" },
  { right: 0, down: 2, value: "1455" },
  { right: 0, down: 2, value: "2038" },
];

/** One captured frame and when, into the recording, it was taken. */
interface Shot {
  file: string;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * run films the window while the script plays, writes what it caught, and quits
 * with a status the shell can read.
 */
export async function runPreview(win: BrowserWindow, quit: (code: number) => void): Promise<void> {
  const dir = process.env["UNO_PREVIEW"];
  if (dir === undefined || dir === "") {
    console.error("preview: UNO_PREVIEW must name a directory for the frames");
    quit(2);
    return;
  }
  await mkdir(dir, { recursive: true });

  // The window is created hidden and shown on ready-to-show, so that it does not
  // flash empty. A capture taken before that comes back blank, which would film
  // as a preview that opens on nothing.
  for (let i = 0; i < 100 && !win.isVisible(); i++) await sleep(50);

  // The window has loaded, but what it opens comes from an engine a moment
  // later. Filming before it does would spend the opening beat on an empty
  // window. The edit story waits for rows; the browse story opens a workspace
  // whose source is missing, so it has none, and waits for the tab's ! instead.
  const story = process.env["UNO_PREVIEW_STORY"] ?? "edit";
  // The sidebar story opens its workspaces itself, the last of them with rows.
  const ready =
    story === "edit" || story === "sidebar" ? "tbody tr:not(.pending)" : ".tab .trouble";
  try {
    if (story === "sidebar") await openWorkspaces(win);
    await win.webContents.executeJavaScript(`
      (async () => {
        for (let i = 0; i < 120; i++) {
          if (document.querySelector(${JSON.stringify(ready)}) !== null) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("nothing was ever drawn at ${ready}");
      })()
    `);
  } catch (err) {
    console.error(`preview: ${(err as Error).message}`);
    quit(1);
    return;
  }

  const rect = await settle(win);

  // One clock. The camera and the script start together and never consult each
  // other again, which is the whole reason for filming from inside the process.
  const start = Date.now();
  const { end, script } = STORIES[story] ?? STORIES["edit"]!;
  let shots: (Shot & { hash: string })[];
  try {
    [shots] = await Promise.all([film(win, dir, rect, start, end), script(win, start)]);
  } catch (err) {
    // A take that fails says why and ends now, rather than leaving the app
    // open for the script's deadline to find.
    console.error(`preview: FAILED -- ${(err as Error).message}`);
    quit(1);
    return;
  }

  // The manifest is what carries the camera's real timing out to the encoder.
  // The hashes stay here; what the encoder needs is when each frame happened.
  const total = Date.now() - start;
  await writeFile(
    join(dir, "frames.json"),
    JSON.stringify({ total, frames: shots.map(({ file, at }) => ({ file, at })) }, null, 2),
  );

  const distinct = new Set(shots.map((s) => s.hash)).size;
  const fps = (shots.length / (total / 1000)).toFixed(1);
  console.log(`preview: ${shots.length} frames over ${(total / 1000).toFixed(1)}s (${fps}/s)`);
  console.log(`preview: ${distinct} distinct`);

  if (distinct < (MIN_DISTINCT[story] ?? 8)) {
    console.error(`preview: FAILED -- ${distinct} distinct frames is a film of a still image`);
    quit(1);
    return;
  }
  console.log("preview: rolled");
  quit(0);
}

/**
 * settle waits for the window to stop being resized, and returns the rectangle
 * every frame will be taken from.
 *
 * Both halves of this matter. A capture taken while the compositor is still
 * placing the window comes out a few pixels off the rest, and one frame of a
 * different size is not a blemish: the GIF encoder cannot describe a resolution
 * change as a delta, so it gives up on delta-encoding the whole file and writes
 * every frame in full. The first take that way was thirty megabytes of a window
 * that hardly moves.
 *
 * So the size is measured once, after it has stopped changing, and then asked
 * for explicitly on every grab. What the window does afterwards cannot reach the
 * film.
 */
/** How often settle reads the window's size, and the most readings it takes. */
const SETTLE_MS = 100;
const SETTLE_READS = 60;
/** How many readings in a row have to agree before the size is taken as settled. */
const STABLE_READS = 6;

/**
 * How many times settle asks for the shape again after measuring what it got.
 * One correction is what a frameless window under Wayland takes: it comes up
 * wider and taller than it was asked to be by a margin of its own, the same
 * every time, so asking for that much less lands on the shape.
 */
const SHAPE_TRIES = 3;

async function settle(win: BrowserWindow): Promise<Rectangle> {
  // Ask for the shape the design is drawn in, as the only size the window can
  // be: main pinned it so before it was shown, which is what has a tiling
  // window manager float it. What comes back is measured, and what it is out
  // by is taken off the next ask.
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
 * stopped waits for the window to stop being resized. Stopped means the same
 * size for a while, not twice in a row: a tiling window manager can take the
 * size it was asked for and change it a few hundred milliseconds later, after
 * two readings have already agreed.
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
 * film grabs the window until the story is over.
 *
 * The timestamps are kept rather than assumed, because a grab takes as long as
 * it takes. Timing every frame from a counter would smear the wait before a
 * keystroke into the keystroke itself; timing them from the clock lets the
 * encoder put each frame back where it actually happened.
 *
 * The PNG is written without waiting for the disk, so the cadence is bounded by
 * the capture and not by the filesystem. The writes are collected and settled
 * before the frames are reported.
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
      // The guard for the bug that produced the first take. A single frame of a
      // different size is not a blemish: it is a resolution change the GIF
      // encoder cannot describe as a delta, so it stops delta-encoding the file
      // entirely and writes every frame in full.
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
 * play performs the story: three cells corrected the way a person corrects them,
 * the offer to correct the rest accepted, then the length of the file, then back
 * to what was fixed.
 *
 * Keys and the click go through sendInputEvent rather than a synthetic DOM event,
 * so every one of them lands wherever the window would send a real one. A
 * preview that dispatched its own events would be filming an assertion about the
 * app rather than the app.
 *
 * The window ignores real input while it is driven, so each one is sent inside
 * `through`, which lets the story's input past and nobody else's.
 */
async function play(win: BrowserWindow, start: number): Promise<void> {
  const at = (ms: number): Promise<void> => sleep(start + ms - Date.now());

  // The story is told in the default keys, whichever this machine last chose.
  win.webContents.send("menu:input", "default");

  // A file opens in view, where nothing a key does changes it.
  await at(BEAT.transform);
  through(win, () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "E", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "E", modifiers: ["control"] });
  });

  // Three corrections, each the same gesture: arrows to reach the cell, the
  // value typed where it sits, Enter to commit. The repetition is the argument.
  for (const [i, beat] of [BEAT.fix1, BEAT.fix2, BEAT.fix3].entries()) {
    await at(beat);
    await fix(win, FIXES[i]!);
  }

  // The banner has offered the rest of the column. Nothing changes until it is
  // accepted, so the story is not finished until Apply is clicked.
  await at(BEAT.apply);
  await click(win, "#banner button.primary");

  // The length of the file, which is the other thing this app claims -- and the
  // proof that Apply reached rows nobody was looking at. Eased rather than
  // assigned: `scrollTop = scrollHeight` is a cut, and a cut says nothing about
  // whether 4,812 rows stay fluid on the way.
  await at(BEAT.toEnd);
  await scroll(win, "end", SCROLL_END);

  // Home is a cut, not a move. Coming back is a return to a view already
  // established, so the travel says nothing the trip out did not -- and it would
  // cost as much again.
  await at(BEAT.toHome);
  await scroll(win, "home", 0);

  // The tail is a resting state: a rewritten column badged `num`, `4 edits` in
  // the status bar, a dot on the tab. A looping preview holds there long enough
  // to be read before it starts over.
  await at(BEAT.end);
}

/**
 * playBrowse performs the browse story: the panel opened, the missing file's
 * folder browsed, a wrong file peeked at and left, the right one pointed at,
 * and the other export added, all from the keyboard; then the themes tried
 * from the settings menu, by the pointer.
 *
 * Every key after Ctrl+Shift+B lands on the panel's list, which holds the keys
 * until the last Enter adds a tab and hands them to the grid.
 */
async function playBrowse(win: BrowserWindow, start: number): Promise<void> {
  const at = (ms: number): Promise<void> => sleep(start + ms - Date.now());

  win.webContents.send("menu:input", "default");

  await at(BROWSE.panel);
  through(win, () => {
    const modifiers: ("control" | "shift")[] = ["control", "shift"];
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "B", modifiers });
  });

  // p on the tab's line, where the panel opened with the keys.
  await at(BROWSE.repoint);
  press(win, "p");

  await at(BROWSE.enter);
  press(win, "Return");
  await at(BROWSE.peek);
  press(win, "Space");
  await at(BROWSE.up);
  press(win, "Backspace");

  await at(BROWSE.walk);
  for (let i = 0; i < 3; i++) {
    press(win, "Down");
    await sleep(ARROW_GAP * 2);
  }
  await at(BROWSE.pick);
  press(win, "Space");

  // Enter with a file picked presses the button under it: Point sales-q3.csv here.
  await at(BROWSE.point);
  press(win, "Return");

  await at(BROWSE.add);
  for (let i = 0; i < 2; i++) {
    press(win, "Up");
    await sleep(ARROW_GAP * 2);
  }
  await sleep(OPEN_PAUSE);
  press(win, "Return");

  // Settings, from the gear at the bottom left, by the pointer: a theme is
  // worn as it is chosen, in light and then in dark, and the take goes back to
  // the one it began in before the menu closes.
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
 * playRefresh performs the refresh story: the panel opened on the tab marked
 * changed, the export regenerated in the bucket while it is open, the window
 * coming back into focus and marking it newer, and Reload from the keys on its
 * line.
 *
 * The window is driven and keeps the focus the whole take, so coming back to
 * it is the focus event a window manager would deliver.
 */
async function playRefresh(win: BrowserWindow, start: number): Promise<void> {
  const at = (ms: number): Promise<void> => sleep(start + ms - Date.now());

  win.webContents.send("menu:input", "default");

  await at(REFRESH.panel);
  through(win, () => {
    const modifiers: ("control" | "shift")[] = ["control", "shift"];
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "B", modifiers });
  });

  await at(REFRESH.rewrite);
  await ask("preview", `rewrite ${REFRESH_KEY}`);

  await at(REFRESH.focus);
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("focus"))`);

  // r on the tab's line, where the panel opened with the keys.
  await at(REFRESH.reload);
  press(win, "r");

  await at(REFRESH.end);
}

/**
 * openWorkspaces opens each workspace the sidebar story lists, in order,
 * before the camera rolls: opening one is what puts it in the sidebar, and a
 * take that began on an empty list would have nothing to show moving between.
 */
async function openWorkspaces(win: BrowserWindow): Promise<void> {
  const paths = JSON.parse(process.env["UNO_PREVIEW_WORKSPACES"] ?? "[]") as string[];
  for (const path of paths) {
    win.webContents.send("menu:open-path", path);
    await win.webContents.executeJavaScript(`
      (async () => {
        const open = () => document.querySelector(".ws.open")?.dataset.path === ${JSON.stringify(path)};
        for (let i = 0; i < 120 && !open(); i++) await new Promise((r) => setTimeout(r, 50));
        if (!open()) throw new Error("${path} never opened");
      })()
    `);
  }
}

/**
 * playSidebar performs the sidebar story, by the pointer: a click on another
 * workspace and back, a right click for the formula form, the expression
 * typed and entered, a save, the sidebar's switch, the + and the ×.
 */
async function playSidebar(win: BrowserWindow, start: number): Promise<void> {
  const at = (ms: number): Promise<void> => sleep(start + ms - Date.now());

  win.webContents.send("menu:input", "default");

  // The workspaces under the open one, most recent first: the first of them,
  // then the one the take began on, which is first of them in its turn.
  await at(SIDEBAR.other);
  await click(win, ".ws:not(.open)");
  await at(SIDEBAR.back);
  await click(win, ".ws:not(.open)");

  // The formula form opens on the column selected, so the empty one is.
  await at(SIDEBAR.column);
  await click(win, "tbody tr:first-child td:last-child");

  await at(SIDEBAR.menu);
  await click(win, ".ws.open", "right");
  await at(SIDEBAR.formula);
  await click(win, ".pop-menu .pop-item");

  // The form opened with the keys in the expression.
  await at(SIDEBAR.typed);
  for (const ch of SIDEBAR_FORMULA) {
    through(win, () => win.webContents.sendInputEvent({ type: "char", keyCode: ch }));
    await sleep(KEYSTROKE);
  }
  await at(SIDEBAR.insert);
  press(win, "Return");

  // Ctrl+S is an accelerator, which is main's, so it is sent as the menu sends it.
  await at(SIDEBAR.save);
  win.webContents.send("menu:save");

  await at(SIDEBAR.fold);
  await click(win, "#sidebar-toggle");
  await at(SIDEBAR.unfold);
  await click(win, "#sidebar-toggle");

  // The dialog the + asks is answered by scripts/preview.js: see smoke/pick.ts.
  await at(SIDEBAR.plus);
  await click(win, "#new");

  // The pointer arrives at the × and stays there. Pressing it would end the take.
  await at(SIDEBAR.close);
  await hover(win, "#close");

  await at(SIDEBAR.end);
}

/** What each story is: how long it runs, and what plays it. */
const STORIES: Record<
  string,
  { end: number; script: (win: BrowserWindow, start: number) => Promise<void> }
> = {
  edit: { end: BEAT.end, script: play },
  browse: { end: BROWSE.end, script: playBrowse },
  refresh: { end: REFRESH.end, script: playRefresh },
  sidebar: { end: SIDEBAR.end, script: playSidebar },
};

/** The pause between the pointer arriving at a button and pressing it. */
const HOVER = 250;

/**
 * click presses the element under a selector with the pointer, the way a person
 * does: it arrives, and then it presses.
 *
 * Only where to press is read from the page. The press itself is a real input
 * event, so a button that was covered or disabled would fail to respond here
 * exactly as it would under a real mouse.
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

/** hover moves the pointer onto the element under a selector, and says where that is. */
async function hover(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  // Found or not is answered rather than thrown: an error thrown in the page
  // arrives here as "Script failed to execute", which names nothing.
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

/** One cell corrected without ever leaving the keyboard. */
async function fix(
  win: BrowserWindow,
  { right, down, value }: { right: number; down: number; value: string },
): Promise<void> {
  for (let i = 0; i < right; i++) {
    press(win, "Right");
    await sleep(ARROW_GAP);
  }
  for (let i = 0; i < down; i++) {
    press(win, "Down");
    await sleep(ARROW_GAP);
  }
  await sleep(OPEN_PAUSE);

  // The first character opens the editor over the selected cell already holding
  // it, the way every spreadsheet does; it is sent as a keydown alone because
  // the grid reads the keydown and puts the character in the field itself.
  // Sending the char too would type it a second time, into the field that the
  // keydown had just focused.
  press(win, value[0]!);
  await sleep(KEYSTROKE);

  // The rest go to the field, which needs the char to insert anything. Typed a
  // character at a time rather than assigned, because a field that fills
  // instantly reads as a screenshot rather than as an edit.
  for (const ch of value.slice(1)) {
    through(win, () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
      win.webContents.sendInputEvent({ type: "char", keyCode: ch });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch });
    });
    await sleep(KEYSTROKE);
  }

  await sleep(PRE_ENTER);
  press(win, "Return");
}

function press(win: BrowserWindow, keyCode: string): void {
  through(win, () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  });
}

/**
 * scroll eases the grid to one end and waits for it to arrive.
 *
 * There is no input event for "scroll smoothly to the end", and a wheel event
 * repeated enough times to cross 4,812 rows would be filming the recorder's
 * patience rather than the virtualiser's.
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
