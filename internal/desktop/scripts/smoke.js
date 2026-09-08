// Does the app actually work?
//
// `vp test` in @uno/grid answers that for the core. This answers it for the
// shell, and it is the only thing that can: a virtualiser, a preload bridge and
// an IPC round trip are all things that either work in a running Electron or
// are not tested at all.
//
// It runs the real built app -- the real main, the real preload, the real
// renderer bundle -- opens the real fixture, and asks the live DOM what it
// shows. Nothing here is a mock.
//
// Usage: node scripts/smoke.js   (after node scripts/build.js)

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const fixture = join(pkg, "../grid/tests/testdata/sales-q3.csv");

// The screenshot goes somewhere it survives the run, because the point of
// taking one is to look at it.
const scratch = join(pkg, "out/smoke");
await mkdir(scratch, { recursive: true });
const electron = (await import("electron")).default;

// Electron needs a display. On a headless machine this is the one thing that
// has to be arranged from outside, so say so plainly rather than time out.
if (process.env["DISPLAY"] === undefined && process.platform === "linux") {
  console.error("smoke: no DISPLAY. Run under Xvfb, or on a desktop session.");
  process.exit(2);
}

const child = spawn(electron, [pkg, fixture], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, UNO_SMOKE: scratch },
});

console.log(`smoke: electron pid ${child.pid}`);

let out = "";
child.stdout.on("data", (b) => {
  out += String(b);
  process.stdout.write(b);
});
child.stderr.on("data", (b) => process.stderr.write(b));

// A hung app is a failure, not something to wait out. The pid is tracked so it
// can be stopped by pid rather than by name.
const DEADLINE_MS = 60_000;
const deadline = setTimeout(() => {
  console.error(`smoke: timed out after ${DEADLINE_MS / 1000}s`);
  if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
}, DEADLINE_MS);

const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(deadline);

if (code !== 0) {
  console.error(`smoke: FAILED (exit ${code})`);
  process.exit(1);
}
if (!out.includes("smoke: all checks passed")) {
  console.error("smoke: FAILED (the app exited cleanly without reporting)");
  process.exit(1);
}
console.log("smoke: ok");
