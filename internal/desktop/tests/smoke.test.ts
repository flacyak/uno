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

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import { displayMissing, electronEnv, verdict } from "../scripts/launch.js";
import { savePathFor } from "../src/main/smoke/save.ts";

const SCRIPTS = fileURLToPath(new URL("../scripts", import.meta.url));
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (name: string) => readFileSync(join(SCRIPTS, name), "utf8");

/** main, split where the app ends and the two branches that know what a test is
 * begin. What is on which side of that line is the point of several tests. */
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
 * Source with its comments taken out, so a rule about what code may say is not
 * also a rule about what a comment may explain.
 *
 * A line comment is only one where the slashes do not follow a colon, because
 * `s3://bucket/key` is not a comment and a scanner that thinks it is would read
 * `http://127.0.0.1:9000` as `http:` and find nothing wrong with it.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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
  // brings it back somewhere nothing in this file is looking. The spread is
  // looked for wherever it is written, not only as the `env:` of a spawn: the
  // smoke run builds a bigger environment than it used to -- the scratch
  // directory, the fixtures, and where the stand-in S3 came up -- and the
  // tempting way to write that is a second object of its own.
  const launchers = ["dev.js", "smoke.js", "preview.js"];
  const spreading = launchers.filter((name) => /\{\s*\.\.\.\s*process\.env/.test(read(name)));
  expect(spreading).toEqual([]);

  for (const name of launchers) {
    expect(read(name), name).toMatch(/env:\s*electronEnv\(process\.env/);
  }
});

test("what the stand-in S3 tells the child is part of that one environment", () => {
  // The engine reads AWS_ENDPOINT_URL_S3 and the access keys from its own
  // environment, and a utility process gets the app's. So pointing the whole
  // app at the stand-in is nothing but these variables arriving -- through
  // electronEnv with everything else, never beside it.
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

test("the stand-in S3 comes up before the app, holding the export the checks add", () => {
  const src = read("smoke.js");
  expect(src).toMatch(/from\s+"\.\.\/\.\.\/grid\/tests\/store\/standin\.ts"/);
  // Seeded with the real bytes of a real export, under a key that looks like one
  // somebody would have in a bucket.
  expect(src).toContain("2025/ads-q3.csv");
  expect(src).toMatch(/await bucket\(/);
  // Only smoke.js knows where the bucket is, so it is the only thing that can
  // tell the checks what to add, the way it already names the local fixture.
  expect(src).toMatch(/UNO_SMOKE_OBJECT:/);
  expect(src).toMatch(/s3:\/\/\$\{BUCKET\}\//);
});

test("the stand-in is shut both ways the run can end", () => {
  // A leaked server holds the port, and the next run comes up on a different
  // one -- which passes, and quietly tests nothing about the one that leaked.
  const src = read("smoke.js");
  const deadline = src.slice(src.indexOf("const deadline"), src.indexOf("const code"));
  expect(deadline).toMatch(/shut\(\)/);
  expect(src.slice(src.indexOf("const code"))).toMatch(/shut\(\)/);
});

test("the workspace the run saved is read back, and its absence is loud", () => {
  const src = read("smoke.js");
  expect(src).toMatch(/readContainer/);
  // The check that triggers the save lives in the app. Until it lands there is
  // no .uno, and "there was nothing to read" has to read as a failure rather
  // than as nothing to do -- the same failure verdict() already guards against.
  expect(src).toMatch(/FAILED \(no \.uno/);
  expect(src).toMatch(/process\.exit\(1\)/);
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

// ------------------------------------------------------------ where it saves

test("a driven run saves into its own scratch directory", () => {
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "sales-q3.uno")).toBe("/tmp/run/sales-q3.uno");
});

test("outside a smoke run there is nowhere of its own, and the dialog stands", () => {
  // The plain app has to keep asking. Answering undefined here is what leaves
  // main with nothing to say and the dialog the only way to say it.
  expect(savePathFor({}, "sales-q3.uno")).toBeUndefined();
  expect(savePathFor({ UNO_SMOKE: "" }, "sales-q3.uno")).toBeUndefined();
});

test("the suggested name is a name, and cannot lead out of the directory", () => {
  // The renderer suggests this, and nothing about a run that writes where it
  // was not told to is worth finding out afterwards.
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "../../etc/passwd")).toBe("/tmp/run/passwd");
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "/etc/passwd")).toBe("/tmp/run/passwd");
  expect(savePathFor({ UNO_SMOKE: "/tmp/run" }, "")).toBe("/tmp/run/workspace.uno");
});

test("the plain app asks where to save, and knows nothing about a test", () => {
  // Save As opens a dialog, a dialog hangs a driven window, and the run can
  // then never save. What must not happen is registerFileHandlers learning
  // about that: it is the app's, and every person who ever saves goes through it.
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
  // Pain point 2. A localhost address compiled into a bundle is one that ships,
  // and the installed app then reaches for a dev server, a proxy or a stand-in
  // that is not there. Every endpoint uno uses arrives in the environment at
  // run time: UNO_RENDERER_URL for the renderer, AWS_ENDPOINT_URL_S3 for the
  // engine. Comments are allowed to say the word; code is not.
  const ADDRESS = /127\.0\.0\.1|\[::1\]|\b0\.0\.0\.0\b|\blocalhost\b|\/\/[^\s"'`]*:\d{2,5}/;
  const named: string[] = [];
  for (const root of [SRC, join(SRC, "../../grid/src")]) {
    for (const file of sources(root)) {
      if (ADDRESS.test(code(readFileSync(file, "utf8")))) named.push(relative(SRC, file));
    }
  }
  expect(named).toEqual([]);
});
