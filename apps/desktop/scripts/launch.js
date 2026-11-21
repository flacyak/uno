/**
 * @fileoverview Starts a real Electron and runs it to the end.
 *
 * dev, smoke and preview share these: whether there is a display, the
 * environment the child gets, driving it while answering what it asks, and
 * the verdict read from what it printed.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";

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
 * Exits with 2, saying so, when this process has no display to open a window
 * on. `who` names the run for the message: "smoke", "preview".
 *
 * @param {string} who
 */
export function requireDisplay(who) {
  if (!displayMissing(process.env, process.platform)) return;
  console.error(`${who}: no DISPLAY. Run under Xvfb, or on a desktop session.`);
  process.exit(2);
}

/** Electron's own installer, which fetches its runtime into the package's dist/. */
const ELECTRON_INSTALLER = createRequire(import.meta.url).resolve("electron/install.js");

/**
 * Runs Electron's installer, which fetches the runtime when the package has
 * none yet and exits at once when it has, and returns its exit status.
 *
 * The package has no install script: it fetches the runtime the first time it
 * is asked for its path, unless ELECTRON_OVERRIDE_DIST_PATH is set. uno-bounded
 * sets it to its headless starter, so a fresh checkout's bounded smoke found
 * no binary. The installer reads the override too, so it runs without it.
 *
 * @param {NodeJS.ProcessEnv} env  usually process.env
 * @param {string} [installer]     the installer to run
 * @returns {number|null} its exit status, null when a signal stopped it
 */
export function fetchElectron(env, installer = ELECTRON_INSTALLER) {
  const installEnv = { ...env };
  delete installEnv["ELECTRON_OVERRIDE_DIST_PATH"];
  return spawnSync(process.execPath, [installer], { stdio: "inherit", env: installEnv }).status;
}

/**
 * Exits with 1, saying so, when Electron's runtime could not be fetched.
 * `who` names the run for the message: "smoke", "preview".
 *
 * @param {string} who
 */
export function requireElectron(who) {
  const status = fetchElectron(process.env);
  if (status === 0) return;
  console.error(`${who}: could not fetch Electron's runtime (installer exit ${status}).`);
  process.exit(1);
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

/** How many ms make a second. */
const MS_PER_SECOND = 1000;

/** The signals a run's own deadline outside it, or a person, stops it with. */
const STOPS = ["SIGTERM", "SIGINT", "SIGHUP"];

/** A process stopped by a signal exits with this plus the signal's number, as a shell reports it. */
const SIGNALLED = 128;

/**
 * drive starts the built app and runs it to the end.
 *
 * What the app prints is passed through, but for a line `<who>: check
 * <name>`, which says the app has begun that check. A line `<who>: ask
 * <what>` is a request to this script: `answer(what)` handles it and returns
 * whether it could, at once or once it is done, and the app is told `done` or
 * `nothing here does` on its stdin.
 *
 * Each check has `deadlineMs`, as does the start before the first. At the
 * deadline the app is killed by pid and `onTimeout` is called. A signal that
 * stops this script kills the app too. Either way, what is printed names the
 * check and how long it ran: by the time the machine was awake, which the
 * deadline counts, and by the clock, which also counts its sleep.
 *
 * @param {string} who  "smoke" or "preview": the prefix of every line the app prints
 * @param {{ electron: string, args: string[], env: NodeJS.ProcessEnv, answer: (what: string) => boolean | Promise<boolean>, deadlineMs: number, onTimeout?: () => void }} run
 * @returns {Promise<{ code: number | null, out: string }>}  the exit code, and everything written to stdout
 */
export async function drive(who, { electron, args, env, answer, deadlineMs, onTimeout }) {
  const child = spawn(electron, args, {
    // stdin carries this script's answers to the app.
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  console.log(`${who}: electron pid ${child.pid}`);

  let step = "the run";
  let began = { awake: performance.now(), clock: Date.now() };
  const seconds = (ms) => Math.round(ms / MS_PER_SECOND);
  const where = () =>
    `in ${step}, ${seconds(performance.now() - began.awake)}s into it awake and ${seconds(Date.now() - began.clock)}s by the clock`;

  let deadline;
  const arm = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      console.error(`${who}: timed out after ${deadlineMs / MS_PER_SECOND}s ${where()}`);
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      onTimeout?.();
    }, deadlineMs);
  };
  arm();
  const stop = (signal) => {
    console.error(`${who}: stopped by ${signal} ${where()}`);
    child.kill("SIGKILL");
    // On the next turn, so every drive under way kills its own app first.
    setImmediate(() => process.exit(SIGNALLED + constants.signals[signal]));
  };
  for (const signal of STOPS) process.once(signal, stop);

  let out = "";
  let pending = "";
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(`${who}: check `)) {
        step = `check "${line.slice(`${who}: check `.length)}"`;
        began = { awake: performance.now(), clock: Date.now() };
        arm();
        continue;
      }
      process.stdout.write(`${line}\n`);
      if (!line.startsWith(`${who}: ask `)) continue;
      const what = line.slice(`${who}: ask `.length);
      void Promise.resolve(answer(what)).then((could) => {
        child.stdin.write(`${who}: ${could ? "done" : "nothing here does"} ${what}\n`);
      });
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(deadline);
  for (const signal of STOPS) process.off(signal, stop);
  process.stdout.write(pending);
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
