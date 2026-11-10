/**
 * @fileoverview The scripted preview: the app plays one short story in its own
 * window while the same process captures frames of the window.
 *
 * Frames are the window's client area, captured with capturePage. The script
 * and the camera share one clock. The frames and a manifest of their timings
 * are written to the UNO_PREVIEW directory for scripts/preview.js to encode.
 *
 * Runs only when UNO_PREVIEW names a directory. src/main/index.ts is its one
 * caller.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { BrowserWindow, Rectangle } from "electron";

import { ask } from "./ask.ts";
import { pick, shownBy, through, throughAsync } from "./driven.ts";

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

/**
 * The moves story's beats: a chart window carried by its head, resized by its
 * grip, stepped with an arrow, and resized with Shift and an arrow.
 */
const MOVES = {
  carry: 500,
  stretch: 2_500,
  nudge: 4_500,
  grow: 5_900,
  end: 7_400,
};

/** How far the moves story carries the window, and how far it resizes it. */
const CARRY = { x: -320, y: 150 };
const STRETCH = { x: 110, y: 90 };

/** How many moves a pointer's drag takes, and how long each one lasts, in ms. */
const DRAG_MOVES = 24;
const DRAG_MOVE_MS = 40;

/** How many times the moves story presses each arrow. */
const NUDGES = 5;

/**
 * The wheel story's beats: the pointer brought over a chart window, the wheel
 * turned down the sheet behind it, and turned back up.
 */
const WHEEL = {
  point: 500,
  down: 1_400,
  up: 3_900,
  end: 6_200,
};

/** How many turns the wheel story makes each way, their px, and the ms each lasts. */
const WHEEL_TURNS = 30;
const WHEEL_TURN_PX = 48;
const WHEEL_TURN_MS = 60;

/**
 * The table story's beats: a chart window given the keys by a click on its
 * head, t pressed for the table of its points, the wheel turned down the
 * table, and t pressed again for the points.
 */
const TABLE = {
  click: 500,
  press: 1_500,
  turn: 2_700,
  back: 5_000,
  end: 6_300,
};

/**
 * The tip story's beats: the pointer brought over a chart window's first
 * bar, glided down its rows, a click on the last for the plot to take the
 * keys, Home for the first row, Right down the rows, and End for the last.
 */
const TIP = {
  point: 500,
  glide: 1_000,
  click: 2_800,
  home: 3_400,
  right: 3_900,
  end: 5_400,
  stop: 6_400,
};

/**
 * The insert story's beats: a cell of region clicked, a right click on the
 * open workspace, Insert chart… chosen, and Enter on the form, which opens on
 * region, for a window of its bars.
 */
const INSERT = {
  column: 500,
  menu: 2_400,
  chart: 4_300,
  enter: 7_800,
  end: 10_000,
};

/**
 * The beats of the stories that open the chart form by Ctrl+Shift+G, :chart
 * and the View menu: a cell of region clicked, the form opened under its
 * header, and Enter on the form for a window of its bars.
 */
const KEYED = { column: 500, open: 2_400, enter: 6_400, end: 8_600 };
/** Where the pointer rests in those stories, on a cell clear of the form and the window it inserts. */
const KEYED_REST = "tbody tr:nth-child(20) td:nth-child(2)";
/** The keys the View menu's Insert chart… shows. */
const INSERT_CHART_KEYS = "CmdOrCtrl+Shift+G";

/**
 * The kinds story's beats: the insert story's, once for a pie of region and
 * once for a scatter of units, with the kind chosen in the form before Enter.
 * Each Down chooses the next kind after bars, KIND_STEP_MS apart. The gutter
 * comes first, so region is a row's third cell and units its sixth, clicked in
 * a row under the pie's window.
 */
const KINDS = [
  { row: 3, cell: 3, downs: 1, column: 500, menu: 2_000, chart: 3_600, choose: 6_400 },
  { row: 15, cell: 6, downs: 2, column: 10_000, menu: 11_600, chart: 13_200, choose: 16_000 },
];
/**
 * The change story's beats: the edit button pressed on a window of region's
 * bars, Down in the form's By for rep, Enter to apply it, then the × pressed
 * once to arm it and again to remove the chart.
 */
const CHANGE = { edit: 800, by: 3_200, apply: 4_600, arm: 7_400, remove: 9_800, end: 12_000 };

/**
 * The schedule story's beats: the edit button pressed on a window of region's
 * bars, Tab to the form's checks, Down to Every 15 min and on to Every…, a
 * number of minutes typed, Enter to apply it, and the form opened on it again.
 */
const SCHEDULE = {
  edit: 800,
  checks: 2_800,
  quarter: 4_000,
  every: 7_000,
  count: 10_200,
  apply: 12_400,
  again: 13_600,
  end: 16_400,
};
/** The Tabs from By to checks, past Sum of and the title, the Downs from By
 * hand to Every 15 min and on to Every…, and the minutes typed in its number. */
const CHECKS_TABS = 3;
const QUARTER_DOWNS = 2;
const EVERY_DOWNS = 4;
const EVERY_MINUTES = "10";

/**
 * The reread story's beats: the export on disk gains North's rows again, the
 * head's refresh button reads it, the export gains South's rows, and r in the
 * window reads it again.
 */
const REREAD = { grow: 800, button: 2_000, again: 5_600, key: 6_800, end: 10_400 };

/** What the focus story holds as it presses F6: nothing three times, then Shift three times. */
const FOCUS_KEYS: Modifier[][] = [[], [], [], ["shift"], ["shift"], ["shift"]];

/**
 * The focus story's beats: a cell pressed, the first F6 once the pointer rests,
 * each press after it a step later, and how long Ctrl+Shift+F holds.
 */
const FOCUS = { cell: 400, first: 3_200, step: 1_600, hold: 1_800 };

/** When the focus story presses Ctrl+Shift+F, a step after the last F6, and its end. */
const FOCUS_FRONT = FOCUS.first + FOCUS_KEYS.length * FOCUS.step;
const FOCUS_END = FOCUS_FRONT + FOCUS.hold;

/** The arrows the aside story presses from rep under the top window, and back out of it. */
const ASIDE_IN = ["Right", "Right", "Right", "Down", "Down"];
const ASIDE_OUT = ["Left", "Left"];

/**
 * The aside story's beats: a cell of rep pressed, the first arrow in once the
 * pointer rests, each after it a step later, the press through the faded
 * window, the first arrow out once the pointer rests again, and its end.
 */
const ASIDE = { cell: 400, first: 3_200, step: 1_000, through: 8_400, out: 11_200, end: 14_000 };

/** How long a Down holds each kind, and how long the last holds before Enter. */
const KIND_STEP_MS = 1_000;
const KIND_HOLD_MS = 1_000;
const KINDS_END = 21_600;

/** How many moves a glide takes, how long each lasts, and how many Rights the tip story presses. */
const GLIDE_MOVES = 24;
const GLIDE_MOVE_MS = 50;
const RIGHTS = 3;

/** A stand-in for the pointer, as a capture leaves the real one out. */
const POINTER =
  '<svg width="16" height="24" viewBox="0 0 16 24">' +
  '<path d="M1 1v18l5-5 3.5 8 3-1.5L9 13h6z" fill="#000" stroke="#fff" stroke-linejoin="round"/>' +
  "</svg>";

/** The side of the move and nwse-resize stand-ins' box, in px, which their arrows fill. */
const ARROWS_BOX = 20;
/** The middle of that box, where the pointer stands. */
const ARROWS_MIDDLE = ARROWS_BOX / 2;

/** The arrows of the stand-ins for the move and nwse-resize cursors, drawn about ARROWS_MIDDLE. */
const FOUR_WAYS =
  "M10 1l3.5 3.5H11V9h4.5V6.5L19 10l-3.5 3.5V11H11v4.5h2.5L10 19l-3.5-3.5H9V11H4.5v2.5L1 10" +
  "l3.5-3.5V9H9V4.5H6.5z";
const TWO_WAYS = "M10 1l4 4h-2.5v10H14l-4 4-4-4h2.5V5H6z";

/** The turn that takes TWO_WAYS from up and down to top-left and bottom-right, in degrees. */
const TO_NWSE = -45;

/** aboutMiddle draws `arrows` about the box's middle, turned `turn` degrees. */
function aboutMiddle(arrows: string, turn: number): string {
  const box = `width="${ARROWS_BOX}" height="${ARROWS_BOX}" viewBox="0 0 ${ARROWS_BOX} ${ARROWS_BOX}"`;
  const turned = `rotate(${turn} ${ARROWS_MIDDLE} ${ARROWS_MIDDLE})`;
  return (
    `<svg ${box}>` +
    `<path d="${arrows}" transform="${turned}" fill="#000" stroke="#fff" stroke-linejoin="round"/>` +
    "</svg>"
  );
}

/** Where the pointer stands in the move and nwse-resize stand-ins. */
const AT_MIDDLE = { x: ARROWS_MIDDLE, y: ARROWS_MIDDLE };

/**
 * The stand-in's pictures by the CSS cursor they draw, each with the point in
 * it that stands where the pointer is.
 */
const PICTURES = {
  default: { svg: POINTER, at: { x: 0, y: 0 } },
  move: { svg: aboutMiddle(FOUR_WAYS, 0), at: AT_MIDDLE },
  "nwse-resize": { svg: aboutMiddle(TWO_WAYS, TO_NWSE), at: AT_MIDDLE },
};

/** The stand-in's id, where a script finds it, and a z-index over the app's popups. */
const POINTER_ID = "preview-pointer";
const POINTER_ON_TOP = 99;

/** The stand-in menu's id, and its gap from the window's edge, menu.ts's EDGE. */
const MENU_ID = "preview-menu";
const MENU_EDGE = 4;
/** What a menu shows for CmdOrCtrl and CommandOrControl, on the platform filming. */
const CMD_OR_CTRL = process.platform === "darwin" ? "Cmd" : "Ctrl";

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

/** A shot and a hash of its pixels. */
interface Hashed extends Shot {
  hash: string;
}

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
  let shots: Hashed[];
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
): Promise<Hashed[]> {
  const shots: Hashed[] = [];
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
  moves: { end: MOVES.end, script: playMoves },
  wheel: { end: WHEEL.end, script: playWheel },
  table: { end: TABLE.end, script: playTable },
  tip: { end: TIP.stop, script: playTip },
  insert: { end: INSERT.end, script: playInsert },
  kinds: { end: KINDS_END, script: playKinds },
  change: { end: CHANGE.end, script: playChange },
  schedule: { end: SCHEDULE.end, script: playSchedule },
  reread: { end: REREAD.end, script: playReread },
  focus: { end: FOCUS_END, script: playFocus },
  aside: { end: ASIDE.end, script: playAside },
  chord: { end: KEYED.end, script: playKeyed((win) => press(win, "G", ["control", "shift"])) },
  command: {
    end: KEYED.end,
    script: playKeyed(async (win) => {
      // The command line is vim-style's.
      win.webContents.send("menu:input", "vim-style");
      await type(win, ":chart");
      press(win, "Return");
    }),
  },
  menu: {
    end: KEYED.end,
    script: playKeyed(async (win, { glideTo, pressOn }) => {
      await pressOn(await standInMenu(win, INSERT_CHART_KEYS));
      await win.webContents.executeJavaScript(`document.getElementById("${MENU_ID}").remove()`);
      pick(INSERT_CHART_KEYS);
      await glideTo(KEYED_REST);
    }),
  },
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
 * playMoves performs the moves story: a chart window carried across the sheet
 * by its head, resized by its grip, stepped left with an arrow, and made
 * taller with Shift and an arrow.
 */
async function playMoves(win: BrowserWindow, at: Clock): Promise<void> {
  await standIn(win);
  await at(MOVES.carry);
  await carry(win, ".chart .chart-title", CARRY);
  await at(MOVES.stretch);
  const grip = await carry(win, ".chart .chart-grip", STRETCH);
  await at(MOVES.nudge);
  await presses(win, "Left", NUDGES, ARROW_GAP);
  // The window steps out from under the pointer, which shows what is there now.
  pointTo(win, grip.x, grip.y);
  await at(MOVES.grow);
  await presses(win, "Down", NUDGES, ARROW_GAP, ["shift"]);
  await at(MOVES.end);
}

/**
 * playWheel performs the wheel story: the sheet scrolled down and back up by a
 * wheel turned over a chart window.
 */
async function playWheel(win: BrowserWindow, at: Clock): Promise<void> {
  await standIn(win);
  await at(WHEEL.point);
  const { x, y } = await hover(win, ".chart:last-child .chart-plot");
  pointTo(win, x, y);
  await at(WHEEL.down);
  await turnWheel(win, x, y, WHEEL_TURN_PX);
  await at(WHEEL.up);
  await turnWheel(win, x, y, -WHEEL_TURN_PX);
  await at(WHEEL.end);
}

/**
 * playTable performs the table story: the last chart window, a scatter's,
 * given the keys by a click on its head, t for the table of its points, the
 * wheel turned down the table, and t again for the points.
 */
async function playTable(win: BrowserWindow, at: Clock): Promise<void> {
  await standIn(win);
  await at(TABLE.click);
  const head = await hover(win, ".chart:last-child .chart-title");
  pointTo(win, head.x, head.y);
  await click(win, ".chart:last-child .chart-title");
  await at(TABLE.press);
  press(win, "t");
  await at(TABLE.turn);
  const { x, y } = await hover(win, ".chart:last-child .chart-plot");
  pointTo(win, x, y);
  await turnWheel(win, x, y, WHEEL_TURN_PX);
  await at(TABLE.back);
  press(win, "t");
  await at(TABLE.end);
}

/**
 * playTip performs the tip story: the pointer over the last chart window's
 * first bar, glided down its rows, a click on the last for the plot to take
 * the keys, Home, Right down the rows, and End.
 */
async function playTip(win: BrowserWindow, at: Clock): Promise<void> {
  await standIn(win);
  await at(TIP.point);
  const rows = ".chart:last-child .chart-bar-row";
  const from = await middle(win, `${rows}:first-child`);
  const to = await middle(win, `${rows}:last-child`);
  pointTo(win, from.x, from.y);
  await at(TIP.glide);
  await glide(win, from, to);
  await at(TIP.click);
  await click(win, `${rows}:last-child`);
  await at(TIP.home);
  press(win, "Home");
  await at(TIP.right);
  await presses(win, "Right", RIGHTS, ARROW_GAP * 2);
  await at(TIP.end);
  press(win, "End");
  await at(TIP.stop);
}

/**
 * playInsert performs the insert story: region selected, then Insert chart…
 * from the workspace's menu, and Enter on the form for its bars.
 */
async function playInsert(win: BrowserWindow, at: Clock): Promise<void> {
  const { pressOn } = await glider(win);
  await at(INSERT.column);
  // The gutter comes first, so region is a row's third cell.
  await pressOn("tbody tr:nth-child(3) td:nth-child(3)");
  await at(INSERT.menu);
  await pressOn(".ws.open", "right");
  await at(INSERT.chart);
  await pressOn(".pop-menu .pop-item:nth-child(2)");
  await at(INSERT.enter);
  press(win, "Return");
  await at(INSERT.end);
}

/**
 * playKinds performs the kinds story: Insert chart… from the workspace's menu
 * on region, then on units, choosing a pie and then a scatter in the form.
 */
async function playKinds(win: BrowserWindow, at: Clock): Promise<void> {
  const { glideTo, pressOn } = await glider(win);
  for (const kind of KINDS) {
    await at(kind.column);
    await pressOn(`tbody tr:nth-child(${kind.row}) td:nth-child(${kind.cell})`);
    await at(kind.menu);
    await pressOn(".ws.open", "right");
    await at(kind.chart);
    await pressOn(".pop-menu .pop-item:nth-child(2)");
    // The first form waits for its module, so the keys wait for the form.
    await waitIn(win, 'document.querySelector(".chart-form")', "the chart form never opened");
    // The pointer leaves the source's name for the kind the keys change.
    await glideTo('.chart-form select[name="kind"]');
    await at(kind.choose);
    // The keys open in By, the field after the kind.
    press(win, "Tab", ["shift"]);
    await presses(win, "Down", kind.downs, KIND_STEP_MS);
    await sleep(KIND_HOLD_MS);
    press(win, "Return");
  }
  await at(KINDS_END);
}

/**
 * playChange performs the change story: the chart form opened on a window from
 * its edit button, By stepped to rep and applied, then the × pressed twice.
 */
async function playChange(win: BrowserWindow, at: Clock): Promise<void> {
  const { glideTo, pressOn } = await glider(win);
  await at(CHANGE.edit);
  await pressOn(".chart .chart-edit");
  // The first form waits for its module, so the keys wait for the form.
  await waitIn(win, 'document.querySelector(".chart-form")', "the chart form never opened");
  await glideTo('.chart-form select[name="by"]');
  await at(CHANGE.by);
  press(win, "Down");
  await at(CHANGE.apply);
  press(win, "Return");
  await at(CHANGE.arm);
  await pressOn(".chart .chart-close");
  await at(CHANGE.remove);
  await pressOn(".chart .chart-close");
  await at(CHANGE.end);
}

/**
 * playSchedule performs the schedule story: the chart form opened on a window
 * from its edit button, checks stepped through Every 15 min to Every…, a
 * number of minutes typed and applied, and the form opened on it again.
 */
async function playSchedule(win: BrowserWindow, at: Clock): Promise<void> {
  const { glideTo, pressOn } = await glider(win);
  await at(SCHEDULE.edit);
  await pressOn(".chart .chart-edit");
  // The first form waits for its module, so the keys wait for the form.
  await waitIn(win, 'document.querySelector(".chart-form")', "the chart form never opened");
  // The pointer rests on the label, clear of what the keys change.
  await glideTo(".chart-form .field:has(.schedule) .what");
  await at(SCHEDULE.checks);
  await presses(win, "Tab", CHECKS_TABS, KIND_STEP_MS / CHECKS_TABS);
  await at(SCHEDULE.quarter);
  await presses(win, "Down", QUARTER_DOWNS, KIND_STEP_MS);
  await at(SCHEDULE.every);
  await presses(win, "Down", EVERY_DOWNS, KIND_STEP_MS);
  await at(SCHEDULE.count);
  press(win, "Tab");
  await type(win, EVERY_MINUTES);
  await at(SCHEDULE.apply);
  press(win, "Return");
  await at(SCHEDULE.again);
  await pressOn(".chart .chart-edit");
  await at(SCHEDULE.end);
}

/**
 * playReread performs the reread story: the export grows on disk twice, and
 * is read again by the head's refresh button the first time and by r the
 * second.
 */
async function playReread(win: BrowserWindow, at: Clock): Promise<void> {
  const { pressOn } = await glider(win);
  await at(REREAD.grow);
  await ask("preview", "grow North");
  await at(REREAD.button);
  await pressOn(".chart .chart-refresh");
  await at(REREAD.again);
  await ask("preview", "grow South");
  // The button keeps the keys, so r goes to its window.
  await at(REREAD.key);
  press(win, "r");
  await at(REREAD.end);
}

/**
 * playFocus performs the focus story: a cell of region pressed, then F6 from
 * the grid to the window at the foot, the one at the top and the grid again,
 * Shift+F6 back through them, then Ctrl+Shift+F to the window on top. The
 * press and the glide after it take until the first F6.
 */
async function playFocus(win: BrowserWindow, at: Clock): Promise<void> {
  const pointer = await glider(win);
  await at(FOCUS.cell);
  // The gutter comes first, so region is a row's third cell.
  await pointer.pressOn("tbody tr:nth-child(3) td:nth-child(3)");
  await pointer.glideTo(KEYED_REST);
  for (const [i, modifiers] of FOCUS_KEYS.entries()) {
    await at(FOCUS.first + i * FOCUS.step);
    press(win, "F6", modifiers);
  }
  await at(FOCUS_FRONT);
  press(win, "F", ["control", "shift"]);
  await at(FOCUS_END);
}

/**
 * playAside performs the aside story: a cell of rep pressed, then Right into
 * channel, units and revenue under the top window, which fades, and Down twice
 * under it, a press through it on a cell of units, then Left into channel and
 * out to rep, which brings the window back.
 */
async function playAside(win: BrowserWindow, at: Clock): Promise<void> {
  const pointer = await glider(win);
  await at(ASIDE.cell);
  // The gutter comes first, so rep is a row's fourth cell, and units its sixth.
  await pointer.pressOn("tbody tr:nth-child(4) td:nth-child(4)");
  await pointer.glideTo(KEYED_REST);
  for (const [i, key] of ASIDE_IN.entries()) {
    await at(ASIDE.first + i * ASIDE.step);
    press(win, key);
  }
  await at(ASIDE.through);
  await pointer.pressOn("tbody tr:nth-child(3) td:nth-child(6)");
  await pointer.glideTo(KEYED_REST);
  for (const [i, key] of ASIDE_OUT.entries()) {
    await at(ASIDE.out + i * ASIDE.step);
    press(win, key);
  }
  await at(ASIDE.end);
}

/**
 * playKeyed gives a story that selects region, opens the chart form on it by
 * `open`, which may move the pointer, and presses Enter on the form for its
 * bars.
 */
function playKeyed(
  open: (win: BrowserWindow, pointer: Glider) => void | Promise<void>,
): Story["script"] {
  return async (win, at) => {
    const pointer = await glider(win);
    await at(KEYED.column);
    // The gutter comes first, so region is a row's third cell.
    await pointer.pressOn("tbody tr:nth-child(3) td:nth-child(3)");
    await pointer.glideTo(KEYED_REST);
    await at(KEYED.open);
    await open(win, pointer);
    await at(KEYED.enter);
    press(win, "Return");
    await at(KEYED.end);
  };
}

/** What the stand-in pointer does: glides to a thing, or glides to it and presses it. */
interface Glider {
  glideTo: (selector: string) => Promise<void>;
  pressOn: (selector: string, button?: "left" | "right") => Promise<void>;
}

/** glider shows the stand-in pointer, which glides from wherever it last went. */
async function glider(win: BrowserWindow): Promise<Glider> {
  await standIn(win);
  let from = await middle(win, "#content");
  const glideTo = async (selector: string): Promise<void> => {
    const to = await middle(win, selector);
    await glide(win, from, to);
    from = to;
  };
  return {
    glideTo,
    pressOn: async (selector, button = "left") => {
      await glideTo(selector);
      await click(win, selector, button);
    },
  };
}

/**
 * turnWheel turns the wheel over (`x`, `y`) WHEEL_TURNS times, `down` px down
 * the page each time. Electron counts a turn down as a negative delta. The
 * scroll a turn causes lands after the page answers it, so the ignore stays
 * lifted until the last turn is over, as driven.ts says, and what a window's
 * own scrollable takes from the wheel scrolls too.
 */
async function turnWheel(win: BrowserWindow, x: number, y: number, down: number): Promise<void> {
  await throughAsync(win, async () => {
    for (let i = 0; i < WHEEL_TURNS; i++) {
      win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaY: -down });
      await sleep(WHEEL_TURN_MS);
    }
  });
}

/** standIn adds the pointer's stand-in to the page, hidden until pointTo moves it. */
async function standIn(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const pointer = document.createElement("div");
      pointer.id = ${JSON.stringify(POINTER_ID)};
      pointer.style.cssText = "position:fixed;z-index:${POINTER_ON_TOP};left:0;top:0;pointer-events:none;display:none";
      pointer.innerHTML = ${JSON.stringify(POINTER)};
      document.body.append(pointer);
    })()
  `);
}

/**
 * standInMenu draws the application menu holding the item that shows `keys`,
 * in the app's own menu look at the window's top-left, as a capture leaves a
 * native menu out and the menu bar shows on macOS alone. It gives the item's
 * selector.
 */
async function standInMenu(win: BrowserWindow, keys: string): Promise<string> {
  const shown = shownBy(keys);
  if (shown === undefined) throw new Error(`no menu item shows ${keys}`);
  const items = shown.menu.submenu?.items.filter((at) => at.visible && at.type !== "separator");
  const rows = items?.map((at) => [
    at.label,
    at.accelerator?.replace(/CmdOrCtrl|CommandOrControl/, CMD_OR_CTRL),
    at === shown.item,
  ]);
  await win.webContents.executeJavaScript(`
    (() => {
      const row = (label, keys) => {
        const [item, shown] = [document.createElement("div"), document.createElement("span")];
        item.className = "pop-item";
        shown.className = "keys";
        shown.textContent = keys ?? "";
        item.append(label, shown);
        return item;
      };
      const menu = document.createElement("div");
      menu.id = "${MENU_ID}";
      menu.className = "pop-menu";
      menu.style.cssText = "left:${MENU_EDGE}px;top:${MENU_EDGE}px";
      // The menu's own label heads it, in the keys' ink.
      const head = row("", ${JSON.stringify(shown.menu.label)});
      head.style.cssText = "pointer-events:none;justify-content:flex-start";
      const items = ${JSON.stringify(rows ?? [])}.map(([label, keys, picked]) => {
        const item = row(label, keys);
        item.toggleAttribute("data-picked", picked);
        return item;
      });
      menu.append(head, ...items);
      document.body.append(menu);
    })()
  `);
  return `#${MENU_ID} [data-picked]`;
}

/**
 * pointTo moves the pointer and its stand-in to (`x`, `y`). The stand-in is
 * drawn as the cursor the page shows there, and keeps its picture while the
 * button is held, as the page's cursor does through a drag.
 */
function pointTo(
  win: BrowserWindow,
  x: number,
  y: number,
  modifiers: "leftbuttondown"[] = [],
): void {
  through(win, () => win.webContents.sendInputEvent({ type: "mouseMove", x, y, modifiers }));
  const held = modifiers.includes("leftbuttondown");
  void win.webContents.executeJavaScript(`
    (() => {
      const pictures = ${JSON.stringify(PICTURES)};
      const pointer = document.getElementById(${JSON.stringify(POINTER_ID)});
      const under = document.elementFromPoint(${x}, ${y});
      const cursor = under === null ? "default" : getComputedStyle(under).cursor;
      const shown = Object.hasOwn(pictures, cursor) ? cursor : "default";
      const picture = ${held} ? (pointer.dataset.picture ?? shown) : shown;
      if (pointer.dataset.picture !== picture) {
        pointer.dataset.picture = picture;
        pointer.innerHTML = pictures[picture].svg;
      }
      const { at } = pictures[picture];
      Object.assign(pointer.style, {
        display: "block",
        transform: "translate(" + (${x} - at.x) + "px, " + (${y} - at.y) + "px)",
      });
    })()
  `);
}

/**
 * carry takes hold of what `selector` picks and drags it `by` px, eased as a
 * hand goes. Gives where it lets go.
 */
async function carry(
  win: BrowserWindow,
  selector: string,
  by: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const { x, y } = await hover(win, selector);
  pointTo(win, x, y);
  await sleep(HOVER);
  const left = { button: "left", clickCount: 1 } as const;
  through(win, () => win.webContents.sendInputEvent({ type: "mouseDown", x, y, ...left }));
  for (let i = 1; i <= DRAG_MOVES; i++) {
    const eased = 1 - (1 - i / DRAG_MOVES) ** 3;
    pointTo(win, x + Math.round(by.x * eased), y + Math.round(by.y * eased), ["leftbuttondown"]);
    await sleep(DRAG_MOVE_MS);
  }
  const to = { x: x + by.x, y: y + by.y };
  through(win, () => win.webContents.sendInputEvent({ type: "mouseUp", ...to, ...left }));
  return to;
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
  const at = await middle(win, selector);
  through(win, () => win.webContents.sendInputEvent({ type: "mouseMove", ...at }));
  return at;
}

/** glide moves the stand-in from `from` to `to`, slowing as it comes. */
async function glide(
  win: BrowserWindow,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  for (let i = 1; i <= GLIDE_MOVES; i++) {
    const eased = 1 - (1 - i / GLIDE_MOVES) ** 3;
    const x = Math.round(from.x + (to.x - from.x) * eased);
    const y = Math.round(from.y + (to.y - from.y) * eased);
    pointTo(win, x, y);
    await sleep(GLIDE_MOVE_MS);
  }
}

/** middle gives the centre of the element matching selector, in the page's px. */
async function middle(win: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
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

/** presses presses keyCode `n` times, `gap` ms apart, with `modifiers` held. */
async function presses(
  win: BrowserWindow,
  keyCode: string,
  n: number,
  gap: number,
  modifiers: Modifier[] = [],
): Promise<void> {
  for (let i = 0; i < n; i++) {
    press(win, keyCode, modifiers);
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
