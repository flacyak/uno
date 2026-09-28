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
// The one thing it does stand in for is the bucket. An object in S3 is opened
// by the real store, over the real wire, with a real signature -- against a
// stand-in that comes up on a port of its own here and is pointed at with the
// same variables the AWS CLI reads. Nothing in the app knows the difference,
// which is the point: no address is compiled into anything, it arrives in the
// environment at run time.
//
// Usage: node scripts/smoke.js   (after node scripts/build.js)

import { readContainer } from "@uno/grid/document";
import { parseConnection } from "@uno/grid/library";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { BUCKET, KEYS, bucket, standinEnv } from "../../grid/tests/store/standin.ts";
import { displayMissing, electronEnv, verdict } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const fixture = join(pkg, "../grid/tests/testdata/sales-q3.csv");
// The export added beside it, for the checks that a workspace holds several.
const second = join(pkg, "../grid/tests/testdata/google-ads-sales.csv");

/** The object pasted into the sources panel: the same export, in the bucket instead of on the disk. */
const KEY = "2025/ads-q3.csv";
/** Beside it, the two the panel browses to, peeks at and adds. */
const BESIDE = ["2025/ads-q4.csv", "2025/sales-q3.csv"];

// The screenshot goes somewhere it survives the run, because the point of
// taking one is to look at it.
const scratch = join(pkg, "out/smoke");
await mkdir(scratch, { recursive: true });

// The workspace this run saves is read back at the end, so the one the last run
// saved has to go first. Otherwise a run that never saved reads a stale file and
// passes on somebody else's evidence.
for (const name of await readdir(scratch)) {
  if (name.endsWith(".uno")) await rm(join(scratch, name));
}

// The app's own data -- its connections folder, the page's storage -- for this
// run only, and emptied first for the reason the .uno above is: a connection
// the last run saved would be evidence this one never produced. It also keeps
// the run out of the connections of whoever is at the desktop.
const data = join(scratch, "data");
await rm(data, { recursive: true, force: true });

// The AWS files the engine reads, for this run only: one profile, finance,
// holding the stand-in's keys. The connect screen lists the profiles it finds
// and the screenshot is published, so a run must never show the names in the
// ~/.aws of whoever started it -- and the profile is what the checks sign in as.
const aws = join(scratch, "aws");
await rm(aws, { recursive: true, force: true });
await mkdir(aws, { recursive: true });
await writeFile(join(aws, "config"), `[profile finance]\nregion = ${HOME_REGION}\n`);
await writeFile(
  join(aws, "credentials"),
  `[finance]\naws_access_key_id = ${KEYS.accessKeyId}\naws_secret_access_key = ${KEYS.secretAccessKey}\n`,
);

const electron = (await import("electron")).default;

if (displayMissing(process.env, process.platform)) {
  console.error("smoke: no DISPLAY. Run under Xvfb, or on a desktop session.");
  process.exit(2);
}

// The bucket is up before the app is, holding the export under a key that looks
// like one somebody would have. It listens on a port the OS picks, so two runs
// at once do not fight over one.
const standin = await bucket(
  undefined,
  undefined,
  new Map([
    [KEY, await readFile(second)],
    [BESIDE[0], await readFile(second)],
    [BESIDE[1], await readFile(fixture)],
  ]),
);
const object = `s3://${BUCKET}/${KEY}`;
console.log(`smoke: stand-in S3 at ${standin.endpoint}, holding ${object}`);

/** Shutting the stand-in, once, whichever way the run ends. A server left
 * listening holds its port, and the next run comes up on a different one --
 * which passes, while testing nothing about the one that leaked. */
let shutting;
const shut = () => (shutting ??= standin.close());

const child = spawn(electron, [pkg, `--user-data-dir=${data}`, fixture], {
  stdio: ["ignore", "pipe", "pipe"],
  env: electronEnv(process.env, {
    UNO_SMOKE: scratch,
    UNO_SMOKE_SOURCE: second,
    // Only this script knows where the bucket came up, so it is the only thing
    // that can tell the checks what to add.
    UNO_SMOKE_OBJECT: object,
    // The endpoint and the keys the engine signs with. A utility process
    // inherits the app's environment, so this is the whole of pointing uno at
    // the stand-in.
    ...standinEnv(standin),
    AWS_CONFIG_FILE: join(aws, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(aws, "credentials"),
  }),
});

console.log(`smoke: electron pid ${child.pid}`);

let out = "";
child.stdout.on("data", (chunk) => {
  out += String(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

// A hung app is a failure, not something to wait out. The pid is tracked so it
// can be stopped by pid rather than by name.
const DEADLINE_MS = 60_000;
const deadline = setTimeout(() => {
  console.error(`smoke: timed out after ${DEADLINE_MS / 1000}s`);
  if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
  void shut();
}, DEADLINE_MS);

const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(deadline);
await shut();

const failed = verdict("smoke", code, out, "smoke: all checks passed");
if (failed !== undefined) {
  console.error(failed);
  process.exit(1);
}

// What the run saved, read the way any other build would read it: a .uno is a
// zip, and this is the same reader the engine opens a workspace with. The
// checks inside the app can see a tab and a status line; only out here can
// anyone see what ended up on the disk.
const written = (await readdir(scratch)).filter((name) => name.endsWith(".uno"));
const saved = written[0];
if (saved === undefined) {
  console.error(`smoke: FAILED (no .uno was written under ${scratch})`);
  console.error("smoke: the run has to save the workspace before it quits -- see src/main/smoke/");
  process.exit(1);
}

const at = join(scratch, saved);
const doc = readContainer(saved, await readFile(at), at);
const pointers = doc.manifest.sources.map((s) => ({ name: s.name, path: s.path }));

const trouble = [];
if (!pointers.some((s) => s.path === object)) {
  trouble.push(
    `the object was saved as ${JSON.stringify(pointers.map((s) => s.path))}, not ${object}`,
  );
}
// The local fixture is nowhere near the scratch directory, so the only true
// thing to write down for it is where it is.
const local = pointers.find((s) => s.name === "sales-q3.csv");
if (local === undefined) trouble.push(`${saved} holds no sales-q3.csv`);
else if (local.path !== fixture) {
  trouble.push(`sales-q3.csv points at ${JSON.stringify(local.path)}, not the absolute ${fixture}`);
}

// The connection the checks saved, read back off the disk the same way: it is
// in the run's own folder, it is a connection, and it holds no key.
const kept = join(data, "connections", "acme-exports.unof");
try {
  const c = parseConnection("acme-exports.unof", await readFile(kept, "utf8"));
  if (c.bucket !== BUCKET) trouble.push(`${kept} connects to ${c.bucket}, not ${BUCKET}`);
  // Saved from the connect screen: signing in as the profile chosen, and with
  // the region the test found rather than one anybody typed.
  if (c.auth.mode !== "profile" || c.auth.profile !== "finance") {
    trouble.push(`${kept} signs in as ${JSON.stringify(c.auth)}, not the finance profile`);
  }
  if (c.region !== HOME_REGION)
    trouble.push(`${kept} holds region ${c.region}, not ${HOME_REGION}`);
  const refused = await readdir(join(data, "connections"));
  if (refused.length !== 1) trouble.push(`the connections folder holds ${JSON.stringify(refused)}`);
} catch (err) {
  trouble.push(`the saved connection did not read back: ${err.message}`);
}

if (trouble.length > 0) {
  for (const line of trouble) console.error(`smoke: FAILED (${line})`);
  process.exit(1);
}

console.log(`smoke: ${saved} points at ${pointers.map((s) => s.path).join(", ")}`);
console.log(`smoke: ${kept} reads back as a connection to ${BUCKET}`);
console.log("smoke: ok");
