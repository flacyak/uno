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
const MIN_DISTINCT = 8;

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

/**
 * The opening story, in the same form: an export in a bucket a long way off,
 * added from the sources panel, and its line in the panel while it opens.
 *
 * scripts/preview.js lays it out against the stand-in bucket, and makes the
 * bucket slow when the story asks it to, so that the open lasts long enough
 * to be watched.
 */
const OPENING = {
  panel: 1_500, // the one tab and its rows have been read
  connection: 2_700, // the panel lists the workspace's tab; down to the bucket
  browse: 3_400, // and into it
  slow: 4_600, // its folder is listed, the keys on the first export in it
  add: 5_200, // Enter adds it, and its line says it is opening
  end: 13_400, // the bar has filled a few times over, and the tab has arrived
};

/** How long the stand-in takes over each answer while the opening story adds from it. */
const OPENING_LATENCY_MS = 1_100;

/**
 * The connecting story, in the same form: a bucket a long way off connected
 * from the sources panel, and its line in the panel while it is tried and kept.
 *
 * scripts/preview.js lays it out as the opening story, with no connection to
 * the bucket kept yet.
 */
const CONNECTING = {
  panel: 1_500, // the one tab and its rows have been read
  line: 2_500, // the panel has no connections; down to the line that connects one
  form: 3_200, // Enter opens the form in the list's place
  bucket: 4_000, // the bucket is typed
  prefix: 5_900, // and the folder in it
  slow: 7_000, // the form has been read
  save: 7_400, // Save connection, and the connection's line says it is connecting
  end: 14_400, // the bar has filled a few times over, and the bucket is browsed
};

/** The bucket and the folder the connecting story types, which the stand-in holds. */
const CONNECTING_BUCKET = "acme-exports";
const CONNECTING_PREFIX = "2025";

/**
 * The refused story is the connecting story with the bucket's name mistyped,
 * so the bucket is not there: the line fails where it was connecting, and is
 * chosen to edit the connection.
 */
const REFUSED_BUCKET = "acme-exprots";
const REFUSED = {
  edit: 12_600, // the line says failed, and why is under the list; Enter edits it
  end: 15_400, // the form is back as it was left, saying why
};
/**
 * How long the stand-in takes over each answer while the connecting story
 * saves. A test is two asks, where an open is four, so each is slower here
 * for the line to be up as long.
 */
const CONNECTING_LATENCY_MS = 1_800;
/** How often a story looks for what a line was waiting on having arrived, and how many times. */
const ARRIVED_MS = 50;
const ARRIVED_LOOKS = 160;

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
  const {
    end,
    script,
    ready = "rows",
    minDistinct = MIN_DISTINCT,
  } = STORIES[story] ?? STORIES["edit"]!;
  const drawn = ready === "rows" ? "tbody tr:not(.pending)" : ".tab .trouble";
  try {
    // The sidebar story opens its workspaces itself, the last of them with rows.
    if (story === "sidebar") await openWorkspaces(win);
    const shown = `document.querySelector(${JSON.stringify(drawn)}) !== null`;
    await waitIn(win, shown, `nothing was ever drawn at ${drawn}`);
  } catch (err) {
    console.error(`preview: ${(err as Error).message}`);
    quit(1);
    return;
  }

  const rect = await settle(win);

  // One clock. The camera and the script start together and never consult each
  // other again, which is the whole reason for filming from inside the process.
  const start = Date.now();
  const at: Clock = (ms) => sleep(start + ms - Date.now());
  // The story is told in the default keys, whichever this machine last chose.
  win.webContents.send("menu:input", "default");
  let shots: (Shot & { hash: string })[];
  try {
    [shots] = await Promise.all([film(win, dir, rect, start, end), script(win, at)]);
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

  if (distinct < minDistinct) {
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
async function play(win: BrowserWindow, at: Clock): Promise<void> {
  // The story is told in the default keys, whichever this machine last chose.
  // A file opens in view, where nothing a key does changes it.
  await at(BEAT.transform);
  press(win, "E", ["control"]);

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
async function playBrowse(win: BrowserWindow, at: Clock): Promise<void> {
  await at(BROWSE.panel);
  press(win, "B", ["control", "shift"]);

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
  await presses(win, "Down", 3, ARROW_GAP * 2);
  await at(BROWSE.pick);
  press(win, "Space");

  // Enter with a file picked presses the button under it: Point sales-q3.csv here.
  await at(BROWSE.point);
  press(win, "Return");

  await at(BROWSE.add);
  await presses(win, "Up", 2, ARROW_GAP * 2);
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
async function playRefresh(win: BrowserWindow, at: Clock): Promise<void> {
  await at(REFRESH.panel);
  press(win, "B", ["control", "shift"]);

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
    const open = `document.querySelector(".ws.open")?.dataset.path === ${JSON.stringify(path)}`;
    await waitIn(win, open, `${path} never opened`);
  }
}

/**
 * waitIn polls the page for `condition`, an expression in its JavaScript, for
 * six seconds, and fails with `failure` where it never holds.
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
 * playSidebar performs the sidebar story, by the pointer: a click on another
 * workspace and back, a right click for the formula form, the expression
 * typed and entered, a save, the sidebar's switch, the + and the ×.
 */
async function playSidebar(win: BrowserWindow, at: Clock): Promise<void> {
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

/** Clock is the story's time: a wait until an offset from the moment the camera rolled. */
type Clock = (ms: number) => Promise<void>;

/**
 * What each story is: how long it runs, what plays it, what the window has to
 * have drawn before the camera rolls, and the fewest distinct frames a take of
 * it can have. The browse story opens a workspace whose source is missing, so
 * it has no rows and waits for the tab's ! instead.
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
 * connection browsed, and the first export in it added with Enter while the
 * bucket is slow, so its line in the workspace section is seen opening before
 * its tab arrives.
 */
async function playOpening(win: BrowserWindow, at: Clock): Promise<void> {
  await at(OPENING.panel);
  press(win, "B", ["control", "shift"]);

  // One tab, so one line down is the connection.
  await at(OPENING.connection);
  press(win, "Down");
  await at(OPENING.browse);
  press(win, "Return");

  // The folder was listed at the stand-in's own speed. From here the bucket
  // is a long way off, which is what the line is for.
  await at(OPENING.slow);
  await ask("preview", `latency ${OPENING_LATENCY_MS}`);
  await at(OPENING.add);
  press(win, "Return");

  // The rows are read at the stand-in's own speed again once the tab is there.
  await arrived(win);
  await ask("preview", "latency 0");

  await at(OPENING.end);
}

/**
 * playConnecting performs the connecting story: the panel opened, the form
 * that connects a bucket filled in from the keyboard, and the connection
 * saved by the pointer while the bucket is slow, so its line in the connections section is
 * seen connecting before the bucket is browsed.
 */
async function playConnecting(win: BrowserWindow, at: Clock): Promise<void> {
  await connect(win, at, CONNECTING_BUCKET);
  await at(CONNECTING.end);
}

/**
 * playRefused performs the refused story: the same form saved with the
 * bucket's name mistyped, its line failing where it was connecting, and Enter
 * on the line bringing the form back to be edited.
 */
async function playRefused(win: BrowserWindow, at: Clock): Promise<void> {
  await connect(win, at, REFUSED_BUCKET);
  await at(REFUSED.edit);
  press(win, "Return");
  await at(REFUSED.end);
}

/**
 * connect is what the connecting and refused stories share: the form filled
 * in with `bucket` and saved while the stand-in is slow, as far as its line
 * having stopped connecting, one way or the other.
 */
async function connect(win: BrowserWindow, at: Clock, bucket: string): Promise<void> {
  await at(CONNECTING.panel);
  press(win, "B", ["control", "shift"]);

  // One tab and no connections, so one line down is + Connect a bucket.
  await at(CONNECTING.line);
  press(win, "Down");
  await at(CONNECTING.form);
  press(win, "Return");

  // The form opens with the keys in the bucket, and Tab is the way to the prefix.
  await at(CONNECTING.bucket);
  await type(win, bucket);
  await at(CONNECTING.prefix);
  press(win, "Tab");
  await sleep(KEYSTROKE);
  await type(win, CONNECTING_PREFIX);

  // Save tests first. From here the bucket is a long way off.
  await at(CONNECTING.slow);
  await ask("preview", `latency ${CONNECTING_LATENCY_MS}`);
  await at(CONNECTING.save);
  await click(win, ".panel-connect button.primary");

  await arrived(win);
  await ask("preview", "latency 0");
}

/**
 * arrived waits for a line of the panel to be seen on its way, a source
 * opening or a connection being kept, and then to have given way to what it
 * was waiting for.
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

/** type types text into the field the keys are in, a character at a time. */
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
  await presses(win, "Right", right, ARROW_GAP);
  await presses(win, "Down", down, ARROW_GAP);
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
  await type(win, value.slice(1));

  await sleep(PRE_ENTER);
  press(win, "Return");
}

/** press is one key down and up, with whatever modifiers are held: a chord where there are. */
function press(win: BrowserWindow, keyCode: string, modifiers: Modifier[] = []): void {
  through(win, () => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  });
}

type Modifier = "control" | "shift";

/** presses is a key pressed `n` times, `gap` apart, the way a person walks a list. */
async function presses(win: BrowserWindow, keyCode: string, n: number, gap: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    press(win, keyCode);
    await sleep(gap);
  }
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
