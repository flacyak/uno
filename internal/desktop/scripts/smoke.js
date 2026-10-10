// Runs the built app on the real fixture and checks what the window shows.
// The checks are in src/main/smoke/.
//
// Main, preload, the renderer bundle and the fixture are all real. Only the
// bucket is a stand-in: an S3 server started here on a port of its own, and
// pointed at with the same variables the AWS CLI reads. The app opens objects
// in it with the real store, over the wire, with a real signature.
//
// Usage: node scripts/smoke.js   (after node scripts/build.js)

import { newManifest, readContainer, writeDocument } from "@uno/grid/document";
import { parseConnection } from "@uno/grid/library";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { BUCKET, KEYS, bucket, etagOf, standinEnv } from "../../grid/tests/store/standin.ts";
import {
  DRIVEN_LANGUAGE_ENV,
  DRIVEN_LANGUAGE_SWITCH,
  displayMissing,
  drive,
  electronEnv,
  rewrite,
  verdict,
} from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const fixture = join(pkg, "../grid/tests/testdata/sales-q3.csv");
// A second export, for the checks that a workspace holds several.
const second = join(pkg, "../grid/tests/testdata/google-ads-sales.csv");

/** The object pasted into the sources panel: the second export, in S3. */
const KEY = "2025/ads-q3.csv";
/** The two objects beside it that the panel browses to, peeks at and adds. */
const BESIDE = ["2025/ads-q4.csv", "2025/sales-q3.csv"];

/**
 * Objects that arrive in the bucket mid-run, when a check asks: the fixture
 * cut into three parts, added as one tab, and a
 * fourth that arrives later and is appended. The fourth is the first part's
 * bytes under a name that sorts after the third.
 */
const PARTS = [1, 2, 3].map((n) => join(pkg, `../grid/tests/testdata/sales-q3-part-${n}.csv`));
const ARRIVING = new Map([
  ...(await Promise.all(
    PARTS.map(async (path, i) => [`shop/2025/sales-q3-part-${i + 1}.csv`, await readFile(path)]),
  )),
  [`shop/2025/sales-q3-part-${PARTS.length + 1}.csv`, await readFile(PARTS[0])],
]);

/**
 * A second, public bucket, and an object a colleague's workspace names in it
 * that has been deleted. Connecting the bucket works; reading the object
 * fails.
 */
const OPEN_BUCKET = "open-data";
const GONE = `s3://${OPEN_BUCKET}/2025/gone.csv`;

// The screenshots and the saved workspace go here, where they outlive the run.
const scratch = join(pkg, "out/smoke");
await mkdir(scratch, { recursive: true });

// The .uno this run saves is read back at the end, so any from a previous
// run is removed first.
for (const name of await readdir(scratch)) {
  if (name.endsWith(".uno")) await rm(join(scratch, name));
}

// The app's own data (connections, page storage), for this run only and
// emptied first.
const data = join(scratch, "data");
await rm(data, { recursive: true, force: true });

// The AWS files the engine reads, for this run only: one profile, finance,
// holding the stand-in's keys. The connect form lists the profiles it finds,
// and the checks sign in as this one.
const aws = join(scratch, "aws");
await rm(aws, { recursive: true, force: true });
await mkdir(aws, { recursive: true });
await writeFile(join(aws, "config"), `[profile finance]\nregion = ${HOME_REGION}\n`);
await writeFile(
  join(aws, "credentials"),
  `[finance]\naws_access_key_id = ${KEYS.accessKeyId}\naws_secret_access_key = ${KEYS.secretAccessKey}\n`,
);

// A workspace a colleague sent: one source, in a bucket this run has no
// connection to. It is in its own folder, since every .uno directly in the
// scratch folder is taken as one this run saved.
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

// The stand-in bucket, started before the app, on a port the OS picks.
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

/** Closes the stand-in once, however the run ends. */
let shutting;
const shut = () => (shutting ??= standin.close());

/**
 * answer handles what a check asks of this script: `rewrite <key>` rewrites
 * the object at <key> with one digit changed, and `put <key> ...` puts the
 * objects held in ARRIVING for those keys into the bucket.
 */
function answer(what) {
  const [verb, ...keys] = what.split(" ");
  if (verb === "put" && keys.length > 0 && keys.every((k) => ARRIVING.has(k))) {
    for (const k of keys) standin.objects.set(k, ARRIVING.get(k));
    return true;
  }
  const [key] = keys;
  if (verb !== "rewrite" || !standin.objects.has(key ?? "")) return false;
  rewrite(standin.objects, key);
  return true;
}

const { code, out } = await drive("smoke", {
  electron,
  args: [pkg, `--user-data-dir=${data}`, DRIVEN_LANGUAGE_SWITCH, fixture],
  env: electronEnv(process.env, {
    ...DRIVEN_LANGUAGE_ENV,
    UNO_SMOKE: scratch,
    UNO_SMOKE_SOURCE: second,
    // The object's address, for the check that adds it.
    UNO_SMOKE_OBJECT: object,
    UNO_SMOKE_SENT: sent,
    // What the + at the foot of the sidebar opens, in place of the Open dialog.
    UNO_DRIVEN_OPEN: second,
    // The stand-in's endpoint and keys. The engine's utility process inherits
    // the app's environment.
    ...standinEnv(standin),
    AWS_CONFIG_FILE: join(aws, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(aws, "credentials"),
  }),
  answer,
  deadlineMs: 60_000,
  onTimeout: () => void shut(),
});
await shut();

const failed = verdict("smoke", code, out, "smoke: all checks passed");
if (failed !== undefined) {
  console.error(failed);
  process.exit(1);
}

// The saved .uno, read with the same reader the engine opens a workspace
// with. Only here can the file on disk be checked.
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
  // The version is the ETag of the bytes it was read as. It was added before
  // any connection was made, so it names none.
  const version = etagOf(await readFile(second));
  if (remote.version !== version) {
    trouble.push(`the object was saved as version ${remote.version}, not ${version}`);
  }
  if (remote.connection !== "") {
    trouble.push(`the object was saved through ${remote.connection}, which was never made`);
  }
}
// The local fixture is saved by its absolute path.
const local = pointers.find((s) => s.name === "sales-q3.csv");
if (local === undefined) trouble.push(`${saved} holds no sales-q3.csv`);
else if (local.path !== fixture) {
  trouble.push(`sales-q3.csv points at ${JSON.stringify(local.path)}, not the absolute ${fixture}`);
}

// The connection the checks saved, read back from the disk: in the run's own
// folder, parses as a connection, and signs in by profile.
const kept = join(data, "connections", "acme-exports.unof");
try {
  const c = parseConnection("acme-exports.unof", await readFile(kept, "utf8"));
  if (c.bucket !== BUCKET) trouble.push(`${kept} connects to ${c.bucket}, not ${BUCKET}`);
  // Saved from the connect form: signed in as the chosen profile, with the
  // region the test detected.
  if (c.auth.mode !== "profile" || c.auth.profile !== "finance") {
    trouble.push(`${kept} signs in as ${JSON.stringify(c.auth)}, not the finance profile`);
  }
  if (c.region !== HOME_REGION)
    trouble.push(`${kept} holds region ${c.region}, not ${HOME_REGION}`);
  // Connected for the reopened workspace, so it covers the object's folder,
  // as the form filled it in.
  if (c.prefix !== "2025/") trouble.push(`${kept} covers ${JSON.stringify(c.prefix)}, not 2025/`);
  // The second connection, to the whole bucket, has its own file, as does the
  // public bucket. The refused bucket left none.
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
