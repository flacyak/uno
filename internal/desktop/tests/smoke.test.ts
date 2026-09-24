// The smoke run's own footing.
//
// scripts/smoke.js is the only thing that answers whether the shell works, so
// what it cannot check is whether it started the app at all. These are the
// pieces of that -- the environment the child gets, whether there is a display,
// and what a finished run amounts to -- asked about here, where no display is
// needed and a wrong answer is a failing test rather than sixty seconds and a
// stack trace out of the bundle.
//
// The run itself stays where it is: `vp run smoke`, on a desktop session.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { displayMissing, electronEnv, verdict } from "../scripts/launch.js";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const read = (name: string) => readFileSync(join(SCRIPTS, name), "utf8");

// ------------------------------------------------------------ the environment

test("the Electron child is not told to run as node", () => {
  // The whole of 0.4. An editor's terminal exports ELECTRON_RUN_AS_NODE for its
  // own helpers; inheriting it turns the app into a plain Node, where
  // `require("electron")` is the npm package -- a path string -- and main dies
  // reading `app` off it. Nothing about the bundle is wrong when that happens,
  // which is why it cost a task to find.
  const env = electronEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" });
  expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
  expect(env["PATH"]).toBe("/usr/bin");
});

test("it is dropped whatever it was set to, because Electron reads only its presence", () => {
  for (const set of ["1", "0", "", "false"]) {
    const env = electronEnv({ ELECTRON_RUN_AS_NODE: set });
    expect("ELECTRON_RUN_AS_NODE" in env, `set to ${JSON.stringify(set)}`).toBe(false);
  }
});

test("the rest of the environment travels, and this run's own variables are added", () => {
  const env = electronEnv(
    { HOME: "/home/someone", DISPLAY: ":0", UNO_SMOKE: "stale" },
    { UNO_SMOKE: "out/smoke", UNO_SMOKE_SOURCE: "google-ads-sales.csv" },
  );
  expect(env).toEqual({
    HOME: "/home/someone",
    DISPLAY: ":0",
    UNO_SMOKE: "out/smoke",
    UNO_SMOKE_SOURCE: "google-ads-sales.csv",
  });
});

test("the caller's own environment is left alone", () => {
  const mine = { ELECTRON_RUN_AS_NODE: "1", HOME: "/home/someone" };
  electronEnv(mine, { UNO_SMOKE: "out/smoke" });
  expect(mine).toEqual({ ELECTRON_RUN_AS_NODE: "1", HOME: "/home/someone" });
});

test("every script that starts Electron goes through electronEnv", () => {
  // A fourth launcher that spreads process.env itself brings the bug back, and
  // brings it back somewhere nothing in this file is looking.
  const spreading = ["dev.js", "smoke.js", "preview.js"].filter((name) =>
    /env:\s*\{\s*\.\.\.process\.env/.test(read(name)),
  );
  expect(spreading).toEqual([]);
});

// ----------------------------------------------------------------- the display

test("a Linux box with no DISPLAY is said to be headless, rather than waited on", () => {
  expect(displayMissing({}, "linux")).toBe(true);
  expect(displayMissing({ DISPLAY: ":1" }, "linux")).toBe(false);
});

test("macOS and Windows always have somewhere to draw", () => {
  for (const platform of ["darwin", "win32"]) {
    expect(displayMissing({}, platform), platform).toBe(false);
  }
});

// ----------------------------------------------------------------- the verdict

test("a run that printed its banner and exited 0 passed", () => {
  const out = "smoke: electron pid 9\n  ok   yy copies\nsmoke: all checks passed\n";
  expect(verdict("smoke", 0, out, "smoke: all checks passed")).toBeUndefined();
});

test("a non-zero exit is a failure, and says which", () => {
  expect(verdict("smoke", 1, "smoke: all checks passed\n", "smoke: all checks passed")).toBe(
    "smoke: FAILED (exit 1)",
  );
  // SIGKILL from the deadline closes the child with a null code, which is not 0
  // and must not read as one.
  expect(verdict("smoke", null, "", "smoke: all checks passed")).toBe("smoke: FAILED (exit null)");
});

test("exiting 0 without ever reporting is a failure, not a pass", () => {
  // The one that looks most like success: the window closed before the checks
  // ran, so there is nothing to print and nothing went wrong.
  const out = "smoke: electron pid 9\n  ok   yy copies\n";
  expect(verdict("smoke", 0, out, "smoke: all checks passed")).toBe(
    "smoke: FAILED (the app exited cleanly without reporting)",
  );
});

test("the banner has to be the whole of it, not a line on the way there", () => {
  expect(verdict("smoke", 0, "  ok   all checks are green\n", "smoke: all checks passed")).toBe(
    "smoke: FAILED (the app exited cleanly without reporting)",
  );
});

test("the run names itself in its own failures", () => {
  expect(verdict("preview", 2, "", "preview: rolled")).toBe("preview: FAILED (exit 2)");
});

// ------------------------------------------------------------------ what it runs

test("smoke opens the app directory, not the main bundle, and on fixtures that exist", () => {
  const src = read("smoke.js");
  // Electron given a file runs that file; given a directory it reads the
  // package's `main`, which is what makes __dirname in the bundle point at
  // out/main and the preload resolve beside it.
  expect(src).toMatch(/spawn\(electron,\s*\[pkg,\s*fixture\]/);
  for (const fixture of ["sales-q3.csv", "google-ads-sales.csv"]) {
    expect(() => readFileSync(join(SCRIPTS, "../../grid/tests/testdata", fixture))).not.toThrow();
  }
});

test("a hung app is killed by pid, on a deadline", () => {
  const src = read("smoke.js");
  expect(src).toMatch(/setTimeout/);
  expect(src).toMatch(/process\.kill\(child\.pid, "SIGKILL"\)/);
});

// -------------------------------------------------------------- what it starts

test("main, preload and the engine are built as CommonJS", () => {
  // A preload script has to be CJS, and main is bundled the same way -- which is
  // why it can declare __dirname, and why an ESM main would resolve every path
  // off import.meta.url to the wrong place without saying so.
  const src = read("bundle.js");
  expect(src).toMatch(/formats:\s*\[\s*"cjs"\s*\]/);
  expect(src).toMatch(/fileName:\s*\(\)\s*=>\s*"index\.cjs"/);
  for (const entry of ["src/main/index.ts", "src/preload/index.ts", "src/engine/index.ts"]) {
    expect(src, entry).toContain(entry);
  }
});

test("electron and node's own modules stay out of the bundle", () => {
  // Bundling a second copy of the platform is the other way main ends up holding
  // an `electron` that is not Electron's.
  expect(read("bundle.js")).toMatch(/external:\s*\[\/\^node:\/,\s*"electron"\]/);
});

test("the package points Electron at the built main", () => {
  const pkg: unknown = JSON.parse(read("../package.json"));
  expect((pkg as { main: string }).main).toBe("out/main/index.cjs");
});
