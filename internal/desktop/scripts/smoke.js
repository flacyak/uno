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

import { newManifest, readContainer, writeDocument } from "@uno/grid/document";
import { parseConnection } from "@uno/grid/library";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { BUCKET, KEYS, bucket, etagOf, standinEnv } from "../../grid/tests/store/standin.ts";
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

/**
 * The objects that are not in the bucket when the run starts and land in it
 * when a check asks: the fixture cut into three parts, which are added as
 * one tab, and a fourth that arrives after them and is appended. The fourth
 * is the first part's bytes again, under the name that sorts after the third.
 */
const PARTS = [1, 2, 3].map((n) => join(pkg, `../grid/tests/testdata/sales-q3-part-${n}.csv`));
const ARRIVING = new Map([
  ...(await Promise.all(
    PARTS.map(async (path, i) => [`shop/2025/sales-q3-part-${i + 1}.csv`, await readFile(path)]),
  )),
  [`shop/2025/sales-q3-part-${PARTS.length + 1}.csv`, await readFile(PARTS[0])],
]);

/**
 * A second, public bucket, and the object a colleague's workspace names in it
 * that has since been deleted. Connecting the bucket works -- it lists -- and
 * reading the object does not, which is what the last checks are about.
 */
const OPEN_BUCKET = "open-data";
const GONE = `s3://${OPEN_BUCKET}/2025/gone.csv`;

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

// The workspace a colleague sent, written the way their uno would have: one
// source pointed at, in a bucket this run has no connection to. It sits in a
// folder of its own, since every .uno directly in the scratch folder is taken
// for one this run saved.
const sent = join(scratch, "sent", "gone.uno");
await mkdir(dirname(sent), { recursive: true });
await writeFile(
  sent,
  writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: "gone",
        name: "gone.csv",
        path: GONE,
        bytes: 0,
        rows: 0,
        cols: 0,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: "gone",
    log: [],
    extra: new Map(),
    at: sent,
  }),
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
  {
    [OPEN_BUCKET]: { objects: new Map([["2025/here.csv", await readFile(fixture)]]), public: true },
  },
);
const object = `s3://${BUCKET}/${KEY}`;
console.log(`smoke: stand-in S3 at ${standin.endpoint}, holding ${object}`);

/** Shutting the stand-in, once, whichever way the run ends. A server left
 * listening holds its port, and the next run comes up on a different one --
 * which passes, while testing nothing about the one that leaked. */
let shutting;
const shut = () => (shutting ??= standin.close());

const child = spawn(electron, [pkg, `--user-data-dir=${data}`, fixture], {
  // stdin carries smoke.js's answers to what the checks ask of it.
  stdio: ["pipe", "pipe", "pipe"],
  env: electronEnv(process.env, {
    UNO_SMOKE: scratch,
    UNO_SMOKE_SOURCE: second,
    // Only this script knows where the bucket came up, so it is the only thing
    // that can tell the checks what to add.
    UNO_SMOKE_OBJECT: object,
    UNO_SMOKE_SENT: sent,
    // What the + at the foot of the sidebar opens, in place of the dialog a
    // driven window cannot answer.
    UNO_DRIVEN_OPEN: second,
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
/**
 * answer does what a check asked of this script, which holds the stand-in, and
 * says so on the app's stdin: `rewrite <key>` writes the object at <key> over
 * with the same bytes but one digit, the same size and a different ETag, as an
 * export regenerated with one figure corrected would be, and `put <key> ...`
 * puts each object held back for those keys into the bucket, as an export
 * landing in its folder would.
 */
function answer(what) {
  const [verb, ...keys] = what.split(" ");
  if (verb === "put" && keys.length > 0 && keys.every((k) => ARRIVING.has(k))) {
    for (const k of keys) standin.objects.set(k, ARRIVING.get(k));
    child.stdin.write(`smoke: done ${what}\n`);
    return;
  }
  const [key] = keys;
  const was = standin.objects.get(key ?? "");
  if (verb !== "rewrite" || was === undefined) {
    child.stdin.write(`smoke: nothing here does ${what}\n`);
    return;
  }
  const now = was.slice();
  const body = now.indexOf(0x0a);
  const at = now.findIndex((c, i) => i > body && c >= 0x30 && c <= 0x39);
  now[at] = now[at] === 0x39 ? 0x30 : now[at] + 1;
  standin.objects.set(key, now);
  child.stdin.write(`smoke: done ${what}\n`);
}

let pending = "";
child.stdout.on("data", (chunk) => {
  out += String(chunk);
  pending += String(chunk);
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (line.startsWith("smoke: ask ")) answer(line.slice("smoke: ask ".length));
  }
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
const pointers = doc.manifest.sources.map((s) => ({
  name: s.name,
  path: s.path,
  version: s.version,
  connection: s.connection,
}));

const trouble = [];
const remote = pointers.find((s) => s.path === object);
if (remote === undefined) {
  trouble.push(
    `the object was saved as ${JSON.stringify(pointers.map((s) => s.path))}, not ${object}`,
  );
} else {
  // Which bytes it was read as goes into the save with it. It was added before
  // any connection was made, so it names none.
  const version = etagOf(await readFile(second));
  if (remote.version !== version) {
    trouble.push(`the object was saved as version ${remote.version}, not ${version}`);
  }
  if (remote.connection !== "") {
    trouble.push(`the object was saved through ${remote.connection}, which was never made`);
  }
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
  // Connected for the reopened workspace, so it covers the folder its object
  // is in, as the form filled it in.
  if (c.prefix !== "2025/") trouble.push(`${kept} covers ${JSON.stringify(c.prefix)}, not 2025/`);
  // The second, for the whole of the same bucket, keeps a file of its own, as
  // does the public bucket the sent workspace named, and the bucket that was
  // refused left none.
  const folder = (await readdir(join(data, "connections"))).toSorted();
  const want = ["acme-exports-2.unof", "acme-exports.unof", `${OPEN_BUCKET}.unof`];
  if (JSON.stringify(folder) !== JSON.stringify(want)) {
    trouble.push(`the connections folder holds ${JSON.stringify(folder)}`);
  }
  const second = parseConnection(
    "acme-exports-2.unof",
    await readFile(join(data, "connections", "acme-exports-2.unof"), "utf8"),
  );
  if (second.prefix !== "")
    trouble.push(`acme-exports-2.unof covers ${second.prefix}, not the whole bucket`);
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
