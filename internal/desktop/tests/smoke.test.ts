// The smoke run's launcher and setup, checked headless.
//
// scripts/smoke.js checks the shell from inside a started app. These tests
// cover the start itself: the environment the child gets, whether there is a
// display, and what a finished run amounts to.
//
// The run itself is `vp run smoke`, on a desktop session.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { displayMissing, electronEnv, verdict } from "../scripts/launch.js";
import { DRIVEN_OPEN, openPathFor } from "../src/main/smoke/pick.ts";
import { savePathFor } from "../src/main/smoke/save.ts";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (name: string) => readFileSync(join(SCRIPTS, name), "utf8");

/** main's source, split into the app's file handlers and the driven branch.
 * Several tests check what is on which side. */
const MAIN = readFileSync(join(SRC, "main/index.ts"), "utf8");
const HANDLERS = MAIN.slice(
  MAIN.indexOf("function registerFileHandlers"),
  MAIN.indexOf("void app.whenReady"),
);
const DRIVEN = MAIN.slice(MAIN.indexOf('const smoke = process.env["UNO_SMOKE"]'));

/** Every .ts under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/**
 * Source with its comments removed, so a rule about code reads code alone.
 *
 * A `//` after a colon is part of a URL, so `s3://bucket/key` and
 * `http://127.0.0.1:9000` stay as code.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ------------------------------------------------------------ the environment

test("the Electron child is not told to run as node", () => {
  // An editor's terminal can export ELECTRON_RUN_AS_NODE. Inherited, it runs
  // the app as plain Node, where `require("electron")` is a path string and
  // main dies reading `app` off it.
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
  // A launcher that spreads process.env itself would bring the bug back. The
  // spread is looked for anywhere in the file, the `env:` of a spawn
  // included.
  const launchers = ["dev.js", "smoke.js", "preview.js"];
  const spreading = launchers.filter((name) => /\{\s*\.\.\.\s*process\.env/.test(read(name)));
  expect(spreading).toEqual([]);

  for (const name of launchers) {
    expect(read(name), name).toMatch(/env:\s*electronEnv\(process\.env/);
  }
});

test("what the stand-in S3 tells the child is part of that one environment", () => {
  // The engine reads AWS_ENDPOINT_URL_S3 and the access keys from its
  // environment, which the utility process inherits from the app. They go
  // through electronEnv with everything else.
  expect(read("smoke.js")).toMatch(/env:\s*electronEnv\(process\.env,\s*\{[^}]*\.\.\.standinEnv\(/);
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
  // SIGKILL from the deadline closes the child with a null code, which is a
  // failure.
  expect(verdict("smoke", null, "", "smoke: all checks passed")).toBe("smoke: FAILED (exit null)");
});

test("exiting 0 without ever reporting is a failure, not a pass", () => {
  // The window closed after the first check and before the verdict line.
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
  // Electron given a directory reads the package's `main`, which makes
  // __dirname in the bundle point at out/main and the preload resolve beside
  // it.
  expect(src).toMatch(
    /args:\s*\[pkg,\s*`--user-data-dir=\$\{data\}`,\s*DRIVEN_LANGUAGE_SWITCH,\s*fixture\]/,
  );
  expect(read("launch.js")).toMatch(/spawn\(electron,\s*args/);
  for (const fixture of ["sales-q3.csv", "google-ads-sales.csv"]) {
    expect(() => readFileSync(join(SCRIPTS, "../../grid/tests/testdata", fixture))).not.toThrow();
  }
});

// A connection the run saves lands in the app's data folder. The run uses a
// folder of its own, emptied first, so the desktop user's connections stay
// as they were.
test("smoke runs with a data folder of its own, emptied first", () => {
  const src = read("smoke.js");
  expect(src).toMatch(
    /const data = join\(scratch, "data"\);\s*await rm\(data, \{ recursive: true, force: true \}\);/,
  );
});

test("a hung app is killed by pid, on a deadline", () => {
  // The deadline is the launcher's, and every driven run names one.
  const src = read("launch.js");
  expect(src).toMatch(/setTimeout/);
  expect(src).toMatch(/process\.kill\(child\.pid, "SIGKILL"\)/);
  for (const name of ["smoke.js", "preview.js"])
    expect(read(name), name).toMatch(/deadlineMs:\s*\d/);
});

test("the stand-in S3 comes up before the app, holding the export the checks add", () => {
  const src = read("smoke.js");
  expect(src).toMatch(/from\s+"\.\.\/\.\.\/grid\/tests\/store\/standin\.ts"/);
  // Seeded with a real export, under a key like one in a real bucket.
  expect(src).toContain("2025/ads-q3.csv");
  expect(src).toMatch(/await bucket\(/);
  // Only smoke.js knows where the bucket is, so it tells the checks what to
  // add through UNO_SMOKE_OBJECT.
  expect(src).toMatch(/UNO_SMOKE_OBJECT:/);
  expect(src).toMatch(/s3:\/\/\$\{BUCKET\}\//);
});

test("the stand-in is shut both ways the run can end", () => {
  // A leaked server holds the port, and the next run comes up on another one.
  const src = read("smoke.js");
  const driven = src.slice(src.indexOf("await drive("), src.indexOf("const failed"));
  expect(driven).toMatch(/onTimeout:.*shut\(\)/);
  expect(driven).toMatch(/\n\s*await shut\(\);/);
});

test("the workspace the run saved is read back, and its absence is loud", () => {
  const src = read("smoke.js");
  expect(src).toMatch(/readContainer/);
  // The check that triggers the save lives in the app. A missing .uno must
  // read as a failure.
  expect(src).toMatch(/FAILED \(no \.uno/);
  expect(src).toMatch(/process\.exit\(1\)/);
});

// -------------------------------------------------------------- what it starts

test("main, preload and the engine are built as CommonJS", () => {
  // A preload script must be CJS, and main is bundled the same way so it can
  // declare __dirname.
  const src = read("bundle.js");
  expect(src).toMatch(/formats:\s*\[\s*"cjs"\s*\]/);
  expect(src).toMatch(/fileName:\s*\(\)\s*=>\s*"index\.cjs"/);
  for (const entry of ["src/main/index.ts", "src/preload/index.ts", "src/engine/index.ts"]) {
    expect(src, entry).toContain(entry);
  }
});

test("electron and node's own modules stay out of the bundle", () => {
  // Bundling a copy of electron would give main an `electron` of its own,
  // apart from Electron's.
  expect(read("bundle.js")).toMatch(/external:\s*\[\/\^node:\/,\s*"electron"\]/);
});

test("the package points Electron at the built main", () => {
  const pkg: unknown = JSON.parse(read("../package.json"));
  expect((pkg as { main: string }).main).toBe("out/main/index.cjs");
});

// ------------------------------------------------------------ where it saves

test("a driven run saves into its own scratch directory", () => {
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "sales-q3.uno")).toBe("/tmp/run/sales-q3.uno");
});

test("outside a smoke run there is nowhere of its own, and the dialog stands", () => {
  // Outside a run, savePathFor answers undefined and main opens the dialog.
  expect(savePathFor({}, "sales-q3.uno")).toBeUndefined();
  expect(savePathFor({ UNO_SMOKE: "" }, "sales-q3.uno")).toBeUndefined();
});

test("the suggested name is a name, and cannot lead out of the directory", () => {
  // The renderer suggests the name. Its base name alone is used, inside the
  // directory.
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "../../etc/passwd")).toBe("/tmp/run/passwd");
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "/etc/passwd")).toBe("/tmp/run/passwd");
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "")).toBe("/tmp/run/workspace.uno");
});

test("the plain app asks where to save, and knows nothing about a test", () => {
  // registerFileHandlers is the app's, and always asks the dialog.
  expect(HANDLERS).toMatch(/ipcMain\.handle\("file:pick-save"[\s\S]*?dialog\.showSaveDialog/);
  expect(HANDLERS).not.toContain("savePathFor");
  expect(HANDLERS).not.toContain("UNO_SMOKE");
});

test("only the driven branch answers where to save by itself", () => {
  expect(DRIVEN).toContain('ipcMain.removeHandler("file:pick-save")');
  expect(DRIVEN).toContain("savePathFor");
  expect(DRIVEN).toContain("./smoke/save.ts");
});

// ------------------------------------------------------- what is compiled in

test("no address and no port is baked into anything that ships", () => {
  // Every endpoint arrives in the environment at run time: UNO_RENDERER_URL
  // for the renderer, AWS_ENDPOINT_URL_S3 for the engine. Comments may name
  // an address. Code naming one fails the test.
  const ADDRESS = /127\.0\.0\.1|\[::1\]|\b0\.0\.0\.0\b|\blocalhost\b|\/\/[^\s"'`]*:\d{2,5}/;
  const named: string[] = [];
  for (const root of [SRC, join(SRC, "../../grid/src")]) {
    for (const file of sources(root)) {
      if (ADDRESS.test(code(readFileSync(file, "utf8")))) named.push(relative(SRC, file));
    }
  }
  expect(named).toEqual([]);
});

// The sidebar's + asks for a file through a dialog. A driven run answers it
// from the environment.
test("a driven run's Open picks the file it was told, and cancels when told none", () => {
  expect(openPathFor({ [DRIVEN_OPEN]: "/tmp/run/google-ads.csv" })).toBe("/tmp/run/google-ads.csv");
  expect(openPathFor({})).toBeUndefined();
  expect(openPathFor({ [DRIVEN_OPEN]: "" })).toBeUndefined();
});
