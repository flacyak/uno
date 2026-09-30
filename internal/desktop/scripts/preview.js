// Records docs/preview.gif.
//
// The app films itself (src/main/preview.ts). This script sets the scene,
// starts the built app on it, then turns the frames it wrote into a GIF.
//
// The stories:
// - `browse` (the README's): finds a workspace's moved export through the
//   sources panel, then tries the themes in settings.
// - `sidebar`: moves between workspaces in the sidebar, inserts a formula from
//   a right click, and opens a new one from the +. Goes to docs/sidebar.gif.
// - `edit`: fixes three cells of the fixture and applies the offer to fix the
//   rest.
// - `refresh`: reopens a workspace whose export in the bucket was rewritten,
//   sees it rewritten again on focus, and reloads it. Filmed against the
//   stand-in bucket. Goes to out/refresh.gif.
// - `opening`: adds an export from a bucket with latency and watches its line
//   in the sources panel while it opens. Goes to out/opening.gif.
// - `connecting`: connects that bucket from the panel's form and watches the
//   connection's line while it is tested and saved. Goes to
//   out/connecting.gif.
// - `refused`: the same with the bucket's name mistyped. The line fails and
//   is chosen to edit the connection. Goes to out/refused.gif.
//
// Usage: node scripts/preview.js [browse|sidebar|edit|refresh|opening|connecting|refused]
// (after node scripts/build.js)

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const root = resolve(pkg, "../..");
const testdata = join(pkg, "../grid/tests/testdata");
const fixture = join(testdata, "sales-q3.csv");

const STORIES = ["browse", "sidebar", "edit", "refresh", "opening", "connecting", "refused"];
/** The stories filmed against the stand-in bucket. Their GIFs go to out/. */
const AGAINST_BUCKET = ["refresh", "opening", "connecting", "refused"];
const story = process.argv[2] ?? "browse";
if (!STORIES.includes(story)) {
  console.error(`preview: no story called ${story} · ${STORIES.join(", ")}`);
  process.exit(2);
}

// The frames are scratch. The GIF goes to docs/, or to out/ for the stories
// filmed against the bucket.
const frames = join(pkg, "out/preview");
const takes = join(root, "docs");
const gif = AGAINST_BUCKET.includes(story)
  ? join(pkg, `out/${story}.gif`)
  : join(takes, story === "sidebar" ? "sidebar.gif" : "preview.gif");

/** The frame rate the GIF is resampled to. */
const FPS = 12;

/** The GIF's width. The window is filmed at 1100x720 and scaled here. */
const WIDTH = 1100;

await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await mkdir(takes, { recursive: true });

/**
 * stage lays out the folder the browse story is filmed in: a workspace saved
 * over the fixture with three cells fixed, the fixture renamed to
 * sales-q3-final.csv since, another export beside it, and a folder of last
 * year's. Returns the .uno's path.
 */
async function stage() {
  // Under the temp folder: the status bar shows the missing file's path, and
  // the GIF is published.
  const dir = await freshDir("exports");
  await mkdir(join(dir, "2024"), { recursive: true });
  const csv = join(dir, "sales-q3.csv");
  const uno = join(dir, "q3-close.uno");
  await copyFile(fixture, csv);
  await copyFile(join(testdata, "google-ads-sales.csv"), join(dir, "google-ads.csv"));
  await copyFile(join(testdata, "google-ads-sales.csv"), join(dir, "2024", "google-ads-2024.csv"));

  // The three cells the edit story fixes, in the units column.
  const fixes = [
    [0, 4, "1204"],
    [2, 4, "1455"],
    [4, 4, "2038"],
  ];
  await savedWorkspace(uno, { name: "sales-q3.csv", path: csv }, fixes, { row: 4, col: 4 });
  await rename(csv, join(dir, "sales-q3-final.csv"));
  return uno;
}

/** freshDir returns an empty folder under the temp folder for one story. */
async function freshDir(name) {
  const dir = join(tmpdir(), "uno-preview", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * savedWorkspace saves a workspace at `uno` over the export `ref` names, with
 * `edits` applied (each a row, a column and a value) and the selection left
 * on `cell`. The engine itself writes the file. `more` is extra providers
 * beside the disk's, for an export in a bucket.
 */
async function savedWorkspace(uno, ref, edits, cell, more = []) {
  const { Engine, messagePort, serve } = await import("@uno/grid/engine");
  const { sources } = await import("@uno/grid/plugin");
  const { Op } = await import("@uno/grid/sheet");
  const { diskProvider } = await import("@uno/grid/store/node");

  const { port1, port2 } = new MessageChannel();
  serve(messagePort(port1), sources([diskProvider(), ...more]));
  const engine = new Engine(messagePort(port2));
  try {
    const {
      sources: [src],
    } = await engine.open(ref);
    if (edits.length > 0) engine.mode(true);
    for (const [row, col, now] of edits) await src.edit({ op: Op.Set, row, col, now });
    const cells = [{ source: src.id, ...cell }];
    await writeFile(uno, await engine.save({ source: src.id, cells, at: uno }, 1 << 20));
  } finally {
    // Only the client's end is closed. Closing the engine's end too would
    // drop the close request before the engine reads it.
    engine.close();
  }
}

/** A connection to the stand-in bucket's 2025/ folder, with machine auth. */
function bucketConnection(bucket, region) {
  return {
    format: 1,
    id: bucket,
    name: `${bucket} / 2025`,
    provider: "s3",
    bucket,
    prefix: "2025/",
    region,
    auth: { mode: "machine" },
    created: undefined,
    modified: undefined,
  };
}

/** The column the sidebar story's formula goes into, added to the export. */
const COMMISSION = "commission";

/**
 * stageSidebar lays out the sidebar story: three workspaces in three folders,
 * each saved by the engine over its own export, and a fourth export with no
 * workspace yet, which the + opens.
 *
 * The export of the workspace the take begins on has an empty commission
 * column at its end for the formula. Returns the workspaces in the order to
 * open them, the one the take begins on last, and the export for the +.
 */
async function stageSidebar() {
  const dir = await freshDir("sidebar");

  // The fixture with one more column, named in the header and empty below.
  const lines = (await readFile(fixture, "utf8")).trimEnd().split(/\r?\n/);
  const widened = lines.map((line, i) => `${line},${i === 0 ? COMMISSION : ""}`).join("\n");

  /** One workspace: a folder, and the export in it the workspace is saved over. */
  const save = async (folder, export_, bytes, name) => {
    await mkdir(join(dir, folder), { recursive: true });
    const csv = join(dir, folder, export_);
    const uno = join(dir, folder, name);
    await writeFile(csv, bytes);
    await savedWorkspace(uno, { name: export_, path: csv }, [], { row: 0, col: 0 });
    return uno;
  };

  const ads = await readFile(join(testdata, "google-ads-sales.csv"));
  const workspaces = [
    await save(
      "treasury",
      "ledger-w32.csv",
      await readFile(join(testdata, "sales-q3-part-2.csv")),
      "liquidity-w32.uno",
    ),
    await save("ads", "google-ads.csv", ads, "ads-review.uno"),
    await save("exports", "sales-q3.csv", widened + "\n", "q3-close.uno"),
  ];

  const fresh = join(dir, "exports", "sales-q4.csv");
  await copyFile(join(testdata, "sales-q3-part-3.csv"), fresh);
  return { workspaces, fresh };
}

/** The object the refresh story's workspace points at, in the stand-in bucket. */
const REFRESH_KEY = "2025/ads-q3.csv";

/**
 * stageRefresh lays out the refresh story: the stand-in bucket holding an
 * export, a workspace saved over it with three campaign names corrected, and
 * the export rewritten since at the same size. Returns the .uno to open, the
 * bucket, and this machine's connection to it.
 */
async function stageRefresh() {
  const { s3Provider } = await import("@uno/grid/store/s3");
  const { BUCKET, KEYS, bucket } = await import("../../grid/tests/store/standin.ts");
  const { HOME_REGION } = await import("../../grid/tests/store/regions.ts");

  const standin = await bucket(
    undefined,
    undefined,
    new Map([[REFRESH_KEY, await readFile(join(testdata, "google-ads-sales.csv"))]]),
  );
  const uno = join(await freshDir("refresh"), "q3-close.uno");

  const bucketReads = s3Provider({
    credentials: () => Promise.resolve({ ...KEYS, region: HOME_REGION }),
    endpoint: standin.endpoint,
  });
  // Three of the campaign names the export misspells, corrected.
  const fixes = [2, 3, 4].map((row) => [row, 1, "Data Analytics Course"]);
  const ref = { name: "ads-q3.csv", path: `s3://${BUCKET}/${REFRESH_KEY}` };
  await savedWorkspace(uno, ref, fixes, { row: 0, col: 0 }, [bucketReads]);
  rewrite(standin.objects, REFRESH_KEY);

  const connection = bucketConnection(BUCKET, HOME_REGION);
  return { uno, standin, connection };
}

/** The exports the opening story's bucket holds. The first is the one added. */
const OPENING_KEYS = ["2025/ads-q3.csv", "2025/ads-q4.csv", "2025/orders-q3.csv"];

/**
 * stageOpening lays out the opening story: the stand-in bucket holding three
 * exports, this machine's connection to it, and the fixture on disk to open
 * first. Returns stageRefresh's shape, with the fixture as the .uno. With
 * `connected` false the connection is left out, for the connecting story.
 */
async function stageOpening(connected) {
  const { BUCKET, bucket } = await import("../../grid/tests/store/standin.ts");
  const { HOME_REGION } = await import("../../grid/tests/store/regions.ts");

  const ads = await readFile(join(testdata, "google-ads-sales.csv"));
  const standin = await bucket(
    undefined,
    undefined,
    new Map(OPENING_KEYS.map((key) => [key, ads])),
  );
  // Under the temp folder, so the path in the GIF is a temp one.
  const csv = join(await freshDir("opening"), "sales-q3.csv");
  await copyFile(fixture, csv);

  const connection = bucketConnection(BUCKET, HOME_REGION);
  return { uno: csv, standin, connection: connected ? connection : undefined };
}

const remote =
  story === "refresh"
    ? await stageRefresh()
    : AGAINST_BUCKET.includes(story)
      ? await stageOpening(story === "opening")
      : undefined;
const sidebar = story === "sidebar" ? await stageSidebar() : undefined;
// The sidebar story opens its own workspaces once the window is up, so the
// app starts with none.
const opened =
  sidebar !== undefined ? [] : [story === "browse" ? await stage() : (remote?.uno ?? fixture)];

const electron = (await import("electron")).default;

if (displayMissing(process.env, process.platform)) {
  console.error("preview: no DISPLAY. Run under Xvfb, or on a desktop session.");
  process.exit(2);
}

// The app's own data (connections, page storage, theme), for this take only
// and emptied first. The GIF is published, and shows only this take's
// connections and theme.
const data = join(pkg, "out/preview-data");
await rm(data, { recursive: true, force: true });

// A story filmed against the bucket gets its own connection, empty AWS files
// in place of the machine's own, and the stand-in's address and keys.
let aws = {};
if (remote !== undefined) {
  const { saveConnection } = await import("@uno/grid/store");
  const { nodeStore } = await import("@uno/grid/store/node");
  const { standinEnv } = await import("../../grid/tests/store/standin.ts");
  await mkdir(join(data, "connections"), { recursive: true });
  if (remote.connection !== undefined) {
    await saveConnection(nodeStore(), join(data, "connections"), remote.connection);
  }
  const files = join(data, "aws");
  await mkdir(files, { recursive: true });
  await writeFile(join(files, "config"), "");
  await writeFile(join(files, "credentials"), "");
  aws = {
    ...standinEnv(remote.standin),
    AWS_CONFIG_FILE: join(files, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(files, "credentials"),
  };
}

// The sidebar story's workspaces, and the file its + opens in place of the
// dialog.
const scene =
  sidebar === undefined
    ? {}
    : {
        UNO_PREVIEW_WORKSPACES: JSON.stringify(sidebar.workspaces),
        UNO_DRIVEN_OPEN: sidebar.fresh,
      };

/**
 * answer handles what the story asks of this script: `rewrite <key>` rewrites
 * the object, and `latency <ms>` sets how long the stand-in delays each
 * answer from here on.
 */
function answer(what) {
  const [verb, key] = what.split(" ");
  if (verb === "rewrite" && remote?.standin.objects.has(key)) {
    rewrite(remote.standin.objects, key);
    return true;
  }
  if (verb === "latency" && remote !== undefined && Number(key) >= 0) {
    remote.standin.latency = Number(key);
    return true;
  }
  return false;
}

const { code, out } = await drive("preview", {
  electron,
  args: [pkg, `--user-data-dir=${data}`, DRIVEN_LANGUAGE_SWITCH, ...opened],
  env: electronEnv(process.env, {
    ...DRIVEN_LANGUAGE_ENV,
    UNO_PREVIEW: frames,
    UNO_PREVIEW_STORY: story,
    ...aws,
    ...scene,
  }),
  answer,
  deadlineMs: 90_000,
});
await remote?.standin.close();

const failed = verdict("preview", code, out, "preview: rolled");
if (failed !== undefined) {
  console.error(failed);
  process.exit(1);
}

// ------------------------------------------------------------------ encoding

const { total, frames: shots } = JSON.parse(await readFile(join(frames, "frames.json"), "utf8"));

// The playlist carries each frame's real duration into the encoder.
const list = join(frames, "playlist.txt");
let text = "ffconcat version 1.0\n";
for (const [i, f] of shots.entries()) {
  const end = i + 1 < shots.length ? shots[i + 1].at : total;
  text += `file ${join(frames, f.file)}\nduration ${((end - f.at) / 1000).toFixed(4)}\n`;
}
// The concat demuxer reads a duration as the gap before the next entry, so
// the last frame is listed once more to hold it.
if (shots.length > 0) text += `file ${join(frames, shots[shots.length - 1].file)}\n`;
await writeFile(list, text);

// The palette is generated from the frames themselves, in the same pass that
// uses it. stats_mode=diff spends the palette on what changes between frames,
// and diff_mode=rectangle rewrites only the rectangle that changed. Each
// pixel takes its nearest palette colour (dither=none).
const filter =
  `fps=${FPS},scale=w=min(${WIDTH}\\,iw):h=-1:flags=lanczos,split[a][b];` +
  `[a]palettegen=stats_mode=diff[p];` +
  `[b][p]paletteuse=dither=none:diff_mode=rectangle`;

const ff = spawn(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-filter_complex",
    filter,
    "-loop",
    "0",
    gif,
  ],
  { stdio: "inherit" },
);
const ffCode = await new Promise((r) => ff.on("close", r));
if (ffCode !== 0) {
  console.error(`preview: ffmpeg failed (exit ${ffCode})`);
  process.exit(1);
}

const { size } = await stat(gif);
console.log(
  `preview: ${gif} (${(size / 1024).toFixed(0)} KB, ${shots.length} frames at ${FPS}fps)`,
);
if (story === "refresh") {
  console.log(`preview: copy it into docs/ when the take is the one you want`);
}
