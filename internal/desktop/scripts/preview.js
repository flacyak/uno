// Shooting docs/preview.gif.
//
// The app films itself -- see src/main/preview.ts for why -- and this is the
// half that lives outside it: start the real built app on the real fixture, then
// turn the frames it left behind into a GIF.
//
// Usage: node scripts/preview.js   (after node scripts/build.js)

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = resolve(pkg, "../..");
const fixture = join(pkg, "../grid/tests/testdata/sales-q3.csv");

// The frames are scratch; the GIF is the artefact, and it goes where the rest of
// the shots of this app go.
const frames = join(pkg, "out/preview");
const takes = join(root, "docs");
const gif = join(takes, "preview.gif");

/** What the GIF is resampled to. Twelve is enough for a caret and a scroll to
 * look continuous, and low enough that fourteen seconds of a mostly still window
 * stays a file worth putting in a README. */
const FPS = 12;

/** The window is filmed at its real 1100x720 and scaled here, because scaling
 * once at the end is sharper than filming small. */
const WIDTH = 1100;

await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await mkdir(takes, { recursive: true });

const electron = (await import("electron")).default;

// Electron needs a display. On a headless machine this is the one thing that has
// to be arranged from outside, so say so plainly rather than time out.
if (process.env["DISPLAY"] === undefined && process.platform === "linux") {
  console.error("preview: no DISPLAY. Run under Xvfb, or on a desktop session.");
  process.exit(2);
}

const child = spawn(electron, [pkg, fixture], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, UNO_PREVIEW: frames },
});

console.log(`preview: electron pid ${child.pid}`);

let out = "";
child.stdout.on("data", (b) => {
  out += String(b);
  process.stdout.write(b);
});
child.stderr.on("data", (b) => process.stderr.write(b));

// A hung app is a failure, not something to wait out. The pid is tracked so it
// can be stopped by pid rather than by name.
const deadline = setTimeout(() => {
  console.error("preview: timed out after 90s");
  if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
}, 90_000);

const code = await new Promise((r) => child.on("close", r));
clearTimeout(deadline);

if (code !== 0) {
  console.error(`preview: FAILED (exit ${code})`);
  process.exit(1);
}
if (!out.includes("preview: rolled")) {
  console.error("preview: FAILED (the app exited cleanly without reporting)");
  process.exit(1);
}

// ------------------------------------------------------------------ encoding

const { total, frames: shots } = JSON.parse(await readFile(join(frames, "frames.json"), "utf8"));

// The playlist is what carries the camera's real timing into the encoder. Handing
// ffmpeg a directory of PNGs instead would assert they were evenly spaced, and a
// grab takes as long as it takes.
const list = join(frames, "playlist.txt");
let text = "ffconcat version 1.0\n";
for (const [i, f] of shots.entries()) {
  const end = i + 1 < shots.length ? shots[i + 1].at : total;
  text += `file ${join(frames, f.file)}\nduration ${((end - f.at) / 1000).toFixed(4)}\n`;
}
// The concat demuxer reads a duration as the gap before the next entry, so the
// last frame needs one more mention to be held rather than flashed.
if (shots.length > 0) text += `file ${join(frames, shots[shots.length - 1].file)}\n`;
await writeFile(list, text);

// The palette is generated from the recording itself in the same pass that uses
// it: 256 colours chosen from these frames rather than from a fixed web palette
// is the difference between readable 12px text and a dithered mess. Most of this
// window is unchanged most of the time, so the palette is spent on what moves,
// and only the rectangle that moved is rewritten in each frame.
//
// Nothing is dithered. Dithering trades bytes for gradients, and this window has
// none -- flat panels, a rule, and antialiased text. Turning it off is both a
// fifth off the file and a cleaner picture, because bayer noise across a white
// grid is the only gradient there would have been.
const filter =
  `fps=${FPS},scale=w=min(${WIDTH}\\,iw):h=-1:flags=lanczos,split[a][b];` +
  `[a]palettegen=stats_mode=diff[p];` +
  `[b][p]paletteuse=dither=none:diff_mode=rectangle`;

const ff = spawn(
  "ffmpeg",
  ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-filter_complex", filter, "-loop", "0", gif],
  { stdio: "inherit" },
);
const ffCode = await new Promise((r) => ff.on("close", r));
if (ffCode !== 0) {
  console.error(`preview: ffmpeg failed (exit ${ffCode})`);
  process.exit(1);
}

const { size } = await stat(gif);
console.log(`preview: ${gif} (${(size / 1024).toFixed(0)} KB, ${shots.length} frames at ${FPS}fps)`);
console.log(`preview: copy it into docs/preview.gif when the take is the one you want`);
