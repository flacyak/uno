/**
 * @fileoverview Packages the built app for one platform and architecture,
 * and zips it.
 *
 * Usage: node scripts/package.js --version <version> [--platform <platform>]
 * [--arch <arch>] (after node scripts/build.js). The platform and the
 * architecture are this machine's unless named, in Node's words, which are
 * Electron's releases' too: darwin, linux or win32, and x64 or arm64.
 *
 * The app is the bundles build.js wrote to out/, copied under a package.json
 * of their own to out/package/app and handed to @electron/packager with the
 * Electron release the workspace pins. Nothing else ships: main, preload and
 * the engine bundle every dependency but Electron and Node's own modules
 * (bundle.js), so the app has no node_modules. The zip is
 * out/package/uno-<version>-<os>-<arch>.zip, with macos, windows or linux as
 * the os, and holds uno.app on macOS and a folder named by the packager,
 * uno-linux-x64 say, elsewhere.
 *
 * The version is an argument, and package.json's stays 0.0.0: a release's
 * version is its tag, and the release workflow passes it here.
 *
 * A macOS app is ad-hoc signed when this runs on macOS. Packaging rewrites
 * the bundle Electron shipped signed, and Apple silicon refuses to start a
 * binary whose signature is no longer valid. A Developer ID signature and
 * notarization would take the ad-hoc signature's place.
 */

import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const out = join(pkg, "out");
const dist = join(out, "package");
const stage = join(dist, "app");

/** The app's name: its executable, its .app bundle and its folder. */
const NAME = "uno";
/** The bundle identifier on macOS. */
const BUNDLE_ID = "io.uno.app";
/** The folders build.js writes, each one bundle. The app's entry is main's. */
const BUNDLES = ["main", "preload", "engine", "renderer"];
/** The platforms a release is built for, in Node's words. */
const PLATFORMS = /** @type {const} */ (["darwin", "linux", "win32"]);
/** The architectures a release is built for. */
const ARCHES = /** @type {const} */ (["x64", "arm64"]);
/** What the zip's name calls each platform. */
/** @type {Record<(typeof PLATFORMS)[number], string>} */
const OS_NAMES = { darwin: "macos", linux: "linux", win32: "windows" };
/** A version: three numbers, and a prerelease after a dash. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Says what is wrong and exits.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`package: ${message}`);
  process.exit(2);
}

/**
 * The member of `allowed` that `value` names, or an exit saying what the
 * flag allows.
 *
 * @template {string} T
 * @param {string} flag
 * @param {readonly T[]} allowed
 * @param {string} value
 * @returns {T}
 */
function oneOf(flag, allowed, value) {
  const found = allowed.find((a) => a === value);
  if (found === undefined) return fail(`--${flag} must be ${allowed.join(", ")}, not ${value}`);
  return found;
}

// `vp run package -- --version 1.0.0` hands the script the `--` as well,
// which would end the options before the first one.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const { values: flags } = parseArgs({
  args: argv,
  options: {
    version: { type: "string" },
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
  },
});
const version = flags.version ?? "";
if (!VERSION.test(version)) {
  fail(`--version must be a version such as 1.2.0 or 1.2.0-rc.1, not "${version}"`);
}
const platform = oneOf("platform", PLATFORMS, flags.platform);
const arch = oneOf("arch", ARCHES, flags.arch);

// The Electron the workspace pins, which is the one the app runs under.
/** @type {{ version: string }} */
const electron = createRequire(import.meta.url)("electron/package.json");

// The stage: the bundles, less their sourcemaps, which Electron does not read,
// under the package.json Electron starts the app from.
for (const bundle of BUNDLES) {
  if (!existsSync(join(out, bundle))) fail(`no out/${bundle}: run node scripts/build.js first`);
}
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const bundle of BUNDLES) {
  await cp(join(out, bundle), join(stage, bundle), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
}
await writeFile(
  join(stage, "package.json"),
  JSON.stringify({ name: NAME, productName: NAME, version, main: "main/index.cjs" }, null, 2),
);

const [appDir] = await packager({
  dir: stage,
  out: dist,
  name: NAME,
  appVersion: version,
  appBundleId: BUNDLE_ID,
  appCategoryType: "public.app-category.productivity",
  electronVersion: electron.version,
  platform,
  arch,
  overwrite: true,
  // The app's files in one archive, which the engine's utility process reads
  // its bundle from as well.
  asar: true,
  // The stage has no node_modules to prune.
  prune: false,
  quiet: true,
});
if (appDir === undefined) fail("the packager wrote nothing");
// The packager leaves the folder readable by its owner alone, as a temporary
// folder is. Unzipped, it should be a folder anyone can enter.
await chmod(appDir, 0o755);

const run = promisify(execFile);
// What the zip holds: the bundle on macOS, the whole folder elsewhere.
const entry = platform === "darwin" ? join(appDir, `${NAME}.app`) : appDir;
if (platform === "darwin" && process.platform === "darwin") {
  await run("codesign", ["--force", "--deep", "--sign", "-", entry]);
}

const zip = join(dist, `${NAME}-${version}-${OS_NAMES[platform]}-${arch}.zip`);
await rm(zip, { force: true });
if (process.platform === "win32") {
  // The bsdtar Windows ships writes a zip when the name says so. It is named
  // by its path: a Git for Windows on the PATH brings a GNU tar, which cannot.
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined) fail("SystemRoot is not set, so there is no tar to zip with");
  const tar = join(systemRoot, "System32", "tar.exe");
  await run(tar, ["-a", "-c", "-f", zip, basename(entry)], { cwd: dirname(entry) });
} else {
  // -y keeps symlinks as symlinks, which a .app bundle's frameworks are made of.
  await run("zip", ["-qry", zip, basename(entry)], { cwd: dirname(entry) });
}
const { size } = await stat(zip);
console.log(`packaged ${relative(pkg, zip)} (${Math.round(size / 1_000_000)} MB)`);
