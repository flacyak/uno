// Starting a real Electron.
//
// dev, smoke and preview all do the same things around the child: decide
// whether there is a display to draw on, build the environment it gets, drive
// it to the end answering what it asks, and read a verdict out of what it
// printed. They live here because each of them fails in a way that looks like
// the app itself is broken, and because a test can ask about them without a
// display.

import { spawn } from "node:child_process";

/**
 * The environment an Electron child is started with.
 *
 * `ELECTRON_RUN_AS_NODE` is deleted rather than passed on. Editors and their
 * terminals set it for their own helpers, and everything started from one
 * inherits it; an Electron binary that sees it starts as a plain Node instead of
 * an app. There is then no browser process, so `require("electron")` finds the
 * npm package -- which exports the path to the binary, a string -- rather than
 * the built-in, and main dies on the first line that touches `app`, reading as
 * though the bundle were at fault.
 *
 * The flag describes how the parent was launched and says nothing about how the
 * app should run, so it does not travel.
 *
 * @param {NodeJS.ProcessEnv} base   usually process.env
 * @param {NodeJS.ProcessEnv} [extra] what this run adds, e.g. UNO_SMOKE
 * @returns {NodeJS.ProcessEnv}
 */
export function electronEnv(base, extra = {}) {
  const env = { ...base, ...extra };
  delete env["ELECTRON_RUN_AS_NODE"];
  return env;
}

/**
 * The language a driven run is in, whatever the machine it runs on prefers.
 *
 * The app follows the system's language until a person chooses one, and a
 * smoke check reads what the window says. Run on a machine that prefers
 * Spanish, the app would say `4812 filas` and every check that reads a word
 * would fail on an app that is working.
 */
export const DRIVEN_LANGUAGE = "en-US";

/**
 * The switch that starts Electron in that language, where a switch decides:
 * macOS and Windows. It goes after the app's directory and its data, with the
 * other switches.
 */
export const DRIVEN_LANGUAGE_SWITCH = `--lang=${DRIVEN_LANGUAGE}`;

/**
 * The environment that starts it in that language, where the environment
 * decides: on Linux Chromium reads LANGUAGE before anything else and does not
 * take the switch over it.
 */
export const DRIVEN_LANGUAGE_ENV = { LANGUAGE: DRIVEN_LANGUAGE.replace("-", "_") };

/**
 * Whether Electron has nowhere to draw.
 *
 * On a headless Linux box this is the one thing that has to be arranged from
 * outside, so it is worth saying plainly rather than waiting for a timeout.
 * macOS and Windows always have a display, and Wayland sessions are reached
 * through Xwayland, which sets DISPLAY like any other.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform  process.platform
 */
export function displayMissing(env, platform) {
  return platform === "linux" && env["DISPLAY"] === undefined;
}

/**
 * What a finished run amounts to, as a line to print, or undefined if it passed.
 *
 * An app that exits 0 without ever saying it got to the end has not passed: it
 * found a way to close the window before the checks ran, which is the failure
 * that looks most like a success.
 *
 * @param {string} name    the run, for the message: "smoke", "preview"
 * @param {number|null} code  the child's exit code
 * @param {string} out     everything it wrote to stdout
 * @param {string} banner  the line it prints only when it finished
 * @returns {string|undefined}
 */
export function verdict(name, code, out, banner) {
  if (code !== 0) return `${name}: FAILED (exit ${code})`;
  if (!out.includes(banner)) {
    return `${name}: FAILED (the app exited cleanly without reporting)`;
  }
  return undefined;
}

/**
 * drive starts the built app and reads it to the end.
 *
 * What the app prints is passed through. A line `<who>: ask <what>` is the app
 * asking this script, which holds what the app cannot -- the stand-in bucket --
 * to do something; `answer(what)` does it and says whether anything here could,
 * and the app is told `done` or `nothing here does` on its stdin. A hung app is
 * a failure, not something to wait out: at `deadlineMs` it is killed by pid,
 * and `onTimeout` is told.
 *
 * @param {string} who  "smoke" or "preview": the prefix of every line the app prints
 * @param {{ electron: string, args: string[], env: NodeJS.ProcessEnv, answer: (what: string) => boolean, deadlineMs: number, onTimeout?: () => void }} run
 * @returns {Promise<{ code: number | null, out: string }>}  the exit code, and everything written to stdout
 */
export async function drive(who, { electron, args, env, answer, deadlineMs, onTimeout }) {
  const child = spawn(electron, args, {
    // stdin carries this script's answers to what the app asks of it.
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  console.log(`${who}: electron pid ${child.pid}`);

  let out = "";
  let pending = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(`${who}: ask `)) continue;
      const what = line.slice(`${who}: ask `.length);
      child.stdin.write(`${who}: ${answer(what) ? "done" : "nothing here does"} ${what}\n`);
    }
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const deadline = setTimeout(() => {
    console.error(`${who}: timed out after ${deadlineMs / 1000}s`);
    if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    onTimeout?.();
  }, deadlineMs);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(deadline);
  return { code, out };
}

/**
 * rewrite writes a stand-in's object over with the same bytes but one digit,
 * the same size and another ETag, the way an export regenerated with one
 * figure corrected is. The digit is the first in the rows, which is on screen.
 *
 * @param {Map<string, Uint8Array>} objects  the stand-in's
 * @param {string} key
 */
export function rewrite(objects, key) {
  const now = objects.get(key).slice();
  const body = now.indexOf(0x0a);
  const at = now.findIndex((c, i) => i > body && c >= 0x30 && c <= 0x39);
  now[at] = now[at] === 0x39 ? 0x30 : now[at] + 1;
  objects.set(key, now);
}
