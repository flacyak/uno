// The scripted preview: the app driving itself through one short story while a
// camera in the same process films it.
//
// This is the second piece of test-shaped code in `src/main`, and it is here for
// the reason `smoke.ts` gives for the first: a window is the only place it can
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

/**
 * How often the camera tries for a frame.
 *
 * Faster than the 12fps the GIF is encoded at, so the encoder is resampling a
 * surplus rather than interpolating a shortfall. That is what keeps a slow grab
 * from reading as a stutter.
 */
const FRAME_INTERVAL = 60;

/**
 * The fewest distinct frames a real take contains.
 *
 * Every other way this can fail is loud. A script that silently did nothing is
 * not: it yields two hundred identical frames and a perfectly valid GIF of a
 * still image, which is the one failure that would ship.
 */
const MIN_DISTINCT = 8;

/**
 * The story, as offsets from the moment the camera rolls.
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
  toEnd: 9_500, // the three corrections have landed and the status bar says so
  toHome: 11_400, // row 4,812 has been up long enough to read
  end: 13_400,
};

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

  // The window has loaded, but the fixture's rows come from an engine a moment
  // later. Filming before they do would spend the opening beat on an empty grid.
  try {
    await win.webContents.executeJavaScript(`
      (async () => {
        for (let i = 0; i < 120; i++) {
          if (document.querySelector("tbody tr:not(.pending)") !== null) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("no rows were ever drawn");
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
  const [shots] = await Promise.all([film(win, dir, rect, start), play(win, start)]);

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

  if (distinct < MIN_DISTINCT) {
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
async function settle(win: BrowserWindow): Promise<Rectangle> {
  // Ask for the shape the design is drawn in. A tiling window manager will
  // refuse, which is its right.
  win.setContentSize(WANT_WIDTH, WANT_HEIGHT);

  let last = "";
  for (let i = 0; i < 40; i++) {
    const [w, h] = win.getContentSize();
    const now = `${w}x${h}`;
    if (now === last) break;
    last = now;
    await sleep(100);
  }

  const { width, height } = (await win.webContents.capturePage()).getSize();
  if (width !== WANT_WIDTH || height !== WANT_HEIGHT) {
    console.warn(
      `preview: filming at ${width}x${height}, not ${WANT_WIDTH}x${WANT_HEIGHT} --` +
        " the window manager placed the window. Float it for a take that matches the design.",
    );
  }
  return { x: 0, y: 0, width, height };
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
): Promise<(Shot & { hash: string })[]> {
  const shots: (Shot & { hash: string })[] = [];
  const writes: Promise<void>[] = [];

  for (let i = 0; ; i++) {
    const at = Date.now() - start;
    if (at >= BEAT.end) break;

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
 * then the length of the file, then back to what was fixed.
 *
 * Keys go through sendInputEvent rather than a synthetic DOM event, so every one
 * of them lands wherever the window has focus -- which is exactly where a real
 * key would land. A preview that dispatched its own events would be filming an
 * assertion about the app rather than the app.
 */
async function play(win: BrowserWindow, start: number): Promise<void> {
  const at = (ms: number): Promise<void> => sleep(start + ms - Date.now());

  // A file opens in view, where nothing a key does changes it.
  await at(BEAT.transform);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "E", modifiers: ["control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "E", modifiers: ["control"] });

  // Three corrections, each the same gesture: arrows to reach the cell, the
  // value typed where it sits, Enter to commit. The repetition is the argument.
  for (const [i, beat] of [BEAT.fix1, BEAT.fix2, BEAT.fix3].entries()) {
    await at(beat);
    await fix(win, FIXES[i]!);
  }

  // The length of the file, which is the other thing this app claims. Eased
  // rather than assigned: `scrollTop = scrollHeight` is a cut, and a cut says
  // nothing about whether 4,812 rows stay fluid on the way.
  await at(BEAT.toEnd);
  await scroll(win, "end", SCROLL_END);

  // Home is a cut, not a move. Coming back is a return to a view already
  // established, so the travel says nothing the trip out did not -- and it would
  // cost as much again.
  await at(BEAT.toHome);
  await scroll(win, "home", 0);

  // The tail is a resting state: three corrected cells, `3 edits` in the status
  // bar, a dot on the tab. A looping preview holds there long enough to be read
  // before it starts over.
  await at(BEAT.end);
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
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch });
    await sleep(KEYSTROKE);
  }

  await sleep(PRE_ENTER);
  press(win, "Return");
}

function press(win: BrowserWindow, keyCode: string): void {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
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
