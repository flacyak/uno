// Starts a real Electron and runs it to the end.
//
// dev, smoke and preview share these: whether there is a display, the
// environment the child gets, driving it while answering what it asks, and
// the verdict read from what it printed.

import { spawn } from "node:child_process";

/**
 * The environment an Electron child is started with: `base` plus `extra`,
 * with `ELECTRON_RUN_AS_NODE` removed.
 *
 * Editors set `ELECTRON_RUN_AS_NODE` for their own helpers, and a child
 * inherits it. An Electron binary that sees it starts as plain Node, with no
 * `app`.
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
 * The language a driven run is in. The smoke checks read the window's text,
 * so the run is held to one language.
 */
export const DRIVEN_LANGUAGE = "en-US";

/** The command line switch that sets the language on macOS and Windows. */
export const DRIVEN_LANGUAGE_SWITCH = `--lang=${DRIVEN_LANGUAGE}`;

/**
 * The environment that sets the language on Linux, where Chromium reads
 * LANGUAGE and ignores the switch.
 */
export const DRIVEN_LANGUAGE_ENV = { LANGUAGE: DRIVEN_LANGUAGE.replace("-", "_") };

/**
 * Whether Electron lacks a display: Linux with DISPLAY unset. macOS and
 * Windows always have one, and Wayland sessions set DISPLAY through Xwayland.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform  process.platform
 */
export function displayMissing(env, platform) {
  return platform === "linux" && env["DISPLAY"] === undefined;
}

/**
 * The failure line for a finished run, or undefined if it passed. A run
 * passes only when it exited 0 and printed `banner`.
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
 * drive starts the built app and runs it to the end.
 *
 * What the app prints is passed through. A line `<who>: ask <what>` is a
 * request to this script: `answer(what)` handles it and returns whether it
 * could, and the app is told `done` or `nothing here does` on its stdin. At
 * `deadlineMs` the app is killed by pid and `onTimeout` is called.
 *
 * @param {string} who  "smoke" or "preview": the prefix of every line the app prints
 * @param {{ electron: string, args: string[], env: NodeJS.ProcessEnv, answer: (what: string) => boolean, deadlineMs: number, onTimeout?: () => void }} run
 * @returns {Promise<{ code: number | null, out: string }>}  the exit code, and everything written to stdout
 */
export async function drive(who, { electron, args, env, answer, deadlineMs, onTimeout }) {
  const child = spawn(electron, args, {
    // stdin carries this script's answers to the app.
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
 * rewrite replaces a stand-in object with the same bytes but one digit
 * changed: the first digit after the header line. The size stays the same
 * and the ETag changes.
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
