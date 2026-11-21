/**
 * @fileoverview Runs the built app on the real fixture and checks what the
 * window shows. The checks are in src/main/smoke/.
 *
 * Main, preload, the renderer bundle and the fixture are all real. Only the
 * bucket is a stand-in: an S3 server started here on a port of its own, and
 * pointed at with the same variables the AWS CLI reads. The app opens objects
 * in it with the real store, over the wire, with a real signature.
 *
 * Usage: node --import ../../paths.js scripts/smoke.js [--affected <base>]
 * (after node scripts/build.js). With --affected, only the groups the files
 * changed since <base> touch are run, by smoke-groups.json; see
 * src/main/smoke/affected.ts. UNO_SMOKE_ONLY set by hand wins over it.
 */

import { newManifest, readContainer, writeDocument } from "@uno/core/document";
import { parseConnection } from "@uno/core/library";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { HOME_REGION } from "@core-tests/store/regions";
import { BUCKET, KEYS, bucket, etagOf, standinEnv } from "@core-tests/store/standin";
import { affected } from "@main/smoke/affected";
import { GROUPS, ONLY_VARIABLE, SCHEDULE, selected } from "@main/smoke/groups";
import SMOKE_MAP from "../smoke-groups.json" with { type: "json" };
import { CHECK_TIMEOUT_MS, MINUTE_MS } from "@renderer/timing";
import {
  DRIVEN_LANGUAGE_ENV,
  DRIVEN_LANGUAGE_SWITCH,
  drive,
  electronEnv,
  requireDisplay,
  requireElectron,
  rewrite,
  verdict,
} from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = join(pkg, "../..");

// --affected <base>: the files changed since the merge base with <base>,
// committed or not, decide the groups, unless UNO_SMOKE_ONLY already has.
// `vp run smoke -- --affected main` hands the script the `--` as well, which
// would end the options before the first one.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const { values: flags } = parseArgs({ args: argv, options: { affected: { type: "string" } } });
if (flags.affected !== undefined && (process.env[ONLY_VARIABLE] ?? "") === "") {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((p) => p !== "");
  const [base] = git("merge-base", flags.affected, "HEAD");
  const changed = [
    ...git("diff", "--name-only", base),
    ...git("ls-files", "--others", "--exclude-standard"),
  ];
  const { groups, unmapped } = affected(SMOKE_MAP, changed);
  for (const path of unmapped)
    console.log(`smoke: ${path} is in no entry of smoke-groups.json, so every group runs`);
  if (groups !== "all" && groups.length === 0) {
    console.log(
      `smoke: nothing changed since ${flags.affected} touches the app, so nothing to smoke`,
    );
    console.log("smoke: ok");
    process.exit(0);
  }
  if (groups !== "all") process.env[ONLY_VARIABLE] = groups.join(",");
  console.log(
    `smoke: ${changed.length} files changed since ${flags.affected} run ${groups === "all" ? "every group" : groups.join(", ")}`,
  );
}
const fixture = join(pkg, "../../core/tests/testdata/sales-q3.csv");
// A second export, for the checks that a workspace holds several.
const second = join(pkg, "../../core/tests/testdata/google-ads-sales.csv");

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
const PARTS = [1, 2, 3].map((n) => join(pkg, `../../core/tests/testdata/sales-q3-part-${n}.csv`));
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

// A workspace with two charts of the second export, in the same folder as the
// one above. Its thirteen columns and 2,600 rows bring out both scrollbars. One
// chart stands at the top of the sheet's right edge and one at its foot.
const charted = join(scratch, "sent", "charted.uno");
const adsChart = {
  source: "ads",
  plot: { t: "bars", by: { col: 10, header: "Location" } },
  title: "",
  refresh: 0,
};
// A new window's size: DEFAULT_WIDTH and DEFAULT_HEIGHT in chart/place.ts.
const chartSize = { width: 420, height: 260 };
// The least size and one step of an arrow: MIN_WIDTH, MIN_HEIGHT and NUDGE_PX there.
const leastSize = { width: 240, height: 160 };
const nudge = 8;
await writeFile(
  charted,
  writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: "ads",
        name: "google-ads-sales.csv",
        path: second,
        rows: 2600,
        cols: 13,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: "ads",
    log: [],
    charts: [
      { ...adsChart, id: "c1", place: { ...chartSize, x: 1, y: 0 } },
      { ...adsChart, id: "c2", place: { ...chartSize, x: 1, y: 1 } },
    ],
    extra: new Map(),
    at: charted,
  }),
);

// A workspace of two charts over a sum per region whose values run long on
// both sides of zero, each in a window of the least width and a new window's
// height: bars of the sums, and a pie of them, whose caption runs past its
// window. The last row's revenue is not a number, for the caption to count
// and find.
const signedFile = join(scratch, "sent", "signed.csv");
const signedHeader = "region,revenue";
const signedRows = [
  "North,1234567.891",
  "Andhra Pradesh regional office,234567.5",
  "West,98765.25",
  "South,-1234567.891",
  "North,n/a",
];
await writeFile(signedFile, `${[signedHeader, ...signedRows].join("\n")}\n`);
const signed = join(scratch, "sent", "signed.uno");
const signedSource = {
  id: "signed",
  name: "signed.csv",
  path: signedFile,
  rows: signedRows.length,
  cols: signedHeader.split(",").length,
  state: { active: { row: 0, col: 0 } },
};
const sums = { t: "bars", by: { col: 0, header: "region" }, sum: { col: 1, header: "revenue" } };
const share = { ...sums, t: "pie" };
const signedPlace = { width: leastSize.width, height: chartSize.height, x: 0, y: 0 };
await writeFile(
  signed,
  writeDocument({
    manifest: newManifest(),
    sources: [signedSource],
    active: signedSource.id,
    log: [],
    charts: [
      { id: "c1", source: signedSource.id, plot: sums, title: "", refresh: 0, place: signedPlace },
      {
        id: "c2",
        source: signedSource.id,
        plot: share,
        title: "",
        refresh: 0,
        place: { ...signedPlace, x: 1 },
      },
    ],
    extra: new Map(),
    at: signed,
  }),
);

// A workspace of one chart, the fixture's revenue against its units, in a new
// window's size. It plots more rows than a scatter draws, so it samples them.
// Its rows and the columns it charts are fixture.ts's ROWS, UNITS and REVENUE,
// of the six columns that file names.
const scattered = join(scratch, "sent", "scattered.uno");
const salesSource = {
  id: "sales",
  name: "sales-q3.csv",
  path: fixture,
  rows: 4812,
  cols: 6,
  state: { active: { row: 0, col: 0 } },
};
const against = { t: "scatter", x: { col: 4, header: "units" }, y: { col: 5, header: "revenue" } };
await writeFile(
  scattered,
  writeDocument({
    manifest: newManifest(),
    sources: [salesSource],
    active: salesSource.id,
    log: [],
    charts: [
      {
        id: "c1",
        source: salesSource.id,
        plot: against,
        title: "",
        refresh: 0,
        place: { ...chartSize, x: 0, y: 0 },
      },
    ],
    extra: new Map(),
    at: scattered,
  }),
);

// A workspace of two scatters along 0 to 800,000: one in a new window's size,
// which has room for the x axis's labels in full, and one of the least width,
// which has not. A third, of the least width, runs along 900,000 to 1,050,000,
// which compact() would round, so its labels crowd even compactly.
const alongFile = join(scratch, "sent", "along.csv");
const alongHeader = "sold,units,price";
const alongRows = ["0,0,900000", "800000,4,1050000"];
await writeFile(alongFile, `${[alongHeader, ...alongRows].join("\n")}\n`);
const along = join(scratch, "sent", "along.uno");
const alongSource = {
  id: "along",
  name: "along.csv",
  path: alongFile,
  rows: alongRows.length,
  cols: alongHeader.split(",").length,
  state: { active: { row: 0, col: 0 } },
};
const soldUnits = { t: "scatter", x: { col: 0, header: "sold" }, y: { col: 1, header: "units" } };
const priceUnits = { ...soldUnits, x: { col: 2, header: "price" } };
const alongChart = { source: alongSource.id, plot: soldUnits, title: "", refresh: 0 };
await writeFile(
  along,
  writeDocument({
    manifest: newManifest(),
    sources: [alongSource],
    active: alongSource.id,
    log: [],
    charts: [
      { ...alongChart, id: "c1", place: { ...chartSize, x: 0, y: 0 } },
      { ...alongChart, id: "c2", place: { ...chartSize, width: leastSize.width, x: 1, y: 0 } },
      {
        ...alongChart,
        id: "c3",
        plot: priceUnits,
        place: { ...chartSize, width: leastSize.width, x: 1, y: 1 },
      },
    ],
    extra: new Map(),
    at: along,
  }),
);

// A workspace of two over-time charts of the fixture's 91 days: rows per day
// in a new window's size at the sheet's foot, which holds a column a day,
// and revenue per day in a window of the least width at its top, which
// holds weeks and not days, and says so.
const timed = join(scratch, "sent", "timed.uno");
const dated = { col: 0, header: "date" };
const perDay = { t: "time", at: dated, per: "day", order: "day" };
const revenuePerDay = { ...perDay, sum: { col: 5, header: "revenue" } };
const timedChart = { source: salesSource.id, title: "", refresh: 0 };
await writeFile(
  timed,
  writeDocument({
    manifest: newManifest(),
    sources: [salesSource],
    active: salesSource.id,
    log: [],
    charts: [
      { ...timedChart, id: "c1", plot: perDay, place: { ...chartSize, x: 0, y: 1 } },
      {
        ...timedChart,
        id: "c2",
        plot: revenuePerDay,
        place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
      },
    ],
    extra: new Map(),
    at: timed,
  }),
);

// A workspace of two histograms of an export of amounts spread over two
// decades, most from 10 to 1,000, and a few far past them either side, so a
// level's bins reach past its 1st to 99th percentile: one in a new window's
// size at the sheet's foot, one of the least width at its top. The amounts
// come from a fixed sequence, so every run draws the same bins.
const spreadFile = join(scratch, "sent", "spread.csv");
const spreadHeader = "amount";
const spreadRows = 2_000;
const spreadSeed = 1_234_567;
const spreadModulus = 2 ** 31 - 1;
const spreadMultiplier = 48_271;
const spreadDecades = 2;
const spreadLeast = 10;
const spreadFar = ["0.5", "0.9", "4800", "5200", "9900"];
const spreadActiveRow = 11;
let spreadState = spreadSeed;
const spreadAmounts = Array.from({ length: spreadRows }, () => {
  spreadState = (spreadState * spreadMultiplier) % spreadModulus;
  // Two draws averaged, so the amounts hump in the middle of their decades.
  const first = spreadState / spreadModulus;
  spreadState = (spreadState * spreadMultiplier) % spreadModulus;
  const both = (first + spreadState / spreadModulus) / 2;
  return `${Math.round(spreadLeast * 10 ** (both * spreadDecades))}`;
});
await writeFile(spreadFile, `${[spreadHeader, ...spreadAmounts, ...spreadFar].join("\n")}\n`);
const spread = join(scratch, "sent", "spread.uno");
const spreadSource = {
  id: "spread",
  name: "spread.csv",
  path: spreadFile,
  rows: spreadRows + spreadFar.length,
  cols: 1,
  // A cell between the two windows, so neither fades aside from it.
  state: { active: { row: spreadActiveRow, col: 0 } },
};
const spreadChart = {
  source: spreadSource.id,
  title: "",
  refresh: 0,
  plot: { t: "histogram", of: { col: 0, header: spreadHeader }, span: "most" },
};
await writeFile(
  spread,
  writeDocument({
    manifest: newManifest(),
    sources: [spreadSource],
    active: spreadSource.id,
    log: [],
    charts: [
      { ...spreadChart, id: "c1", place: { ...chartSize, x: 0, y: 1 } },
      { ...spreadChart, id: "c2", place: { ...chartSize, width: leastSize.width, x: 1, y: 0 } },
    ],
    extra: new Map(),
    at: spread,
  }),
);

// A workspace of two box plots of an export of four regions' amounts, each
// spread its own way, East's with two far past its whiskers: one box per
// region in a new window's size at the sheet's foot, and one box of every
// amount in a window of the least width at its top.
const boxedFile = join(scratch, "sent", "boxed.csv");
const boxedHeader = "region,amount";
const boxedRegions = { North: [10, 90], South: [50, 250], East: [5, 55], West: [100, 50] };
const boxedRows = Object.entries(boxedRegions).flatMap(([region, [base, range]]) =>
  Array.from({ length: spreadRows / 10 }, (_, i) => `${region},${base + ((i * 37) % range)}`),
);
boxedRows.push("East,600", "East,900");
await writeFile(boxedFile, `${[boxedHeader, ...boxedRows].join("\n")}\n`);
const boxed = join(scratch, "sent", "boxed.uno");
const boxedSource = {
  ...spreadSource,
  id: "boxed",
  name: "boxed.csv",
  path: boxedFile,
  rows: boxedRows.length,
  cols: 2,
};
const amountOf = { col: 1, header: "amount" };
const boxedChart = { source: boxedSource.id, title: "", refresh: 0 };
await writeFile(
  boxed,
  writeDocument({
    manifest: newManifest(),
    sources: [boxedSource],
    active: boxedSource.id,
    log: [],
    charts: [
      {
        ...boxedChart,
        id: "c1",
        plot: { t: "box", of: amountOf, by: { col: 0, header: "region" }, span: "most" },
        place: { ...chartSize, x: 0, y: 1 },
      },
      {
        ...boxedChart,
        id: "c2",
        plot: { t: "box", of: amountOf, span: "most" },
        place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
      },
    ],
    extra: new Map(),
    at: boxed,
  }),
);

// A workspace of two beeswarms of the box plots' amounts: a strip per region
// in a window tall enough for four at the sheet's foot on the right, and one
// strip of every amount in a window of the least width at its top on the left,
// so neither stands over the selected cell and fades aside.
const swarmed = join(scratch, "sent", "swarmed.uno");
// Four strips of two rows, the axis's and the caption's take this much.
const swarmTall = 400;
await writeFile(
  swarmed,
  writeDocument({
    manifest: newManifest(),
    sources: [boxedSource],
    active: boxedSource.id,
    log: [],
    charts: [
      {
        ...boxedChart,
        id: "c1",
        plot: { t: "swarm", of: amountOf, by: { col: 0, header: "region" } },
        place: { ...chartSize, height: swarmTall, x: 1, y: 1 },
      },
      {
        ...boxedChart,
        id: "c2",
        plot: { t: "swarm", of: amountOf },
        place: { ...chartSize, width: leastSize.width, x: 0, y: 0 },
      },
    ],
    extra: new Map(),
    at: swarmed,
  }),
);

// A workspace of two parallel coordinates of an export of a thousand orders'
// eight numbers: four axes in a new window's size at the sheet's foot on the
// right, and all eight in a window of the least width at its top on the left,
// which scrolls sideways to keep its axes apart.
const parallelFile = join(scratch, "sent", "parallel.csv");
// Each order's numbers hang on a base of its units, so lines run together,
// apart and across, with a little noise each.
const parallelColumns = {
  units: (base) => base,
  revenue: (base, i) => base * 3 + ((i * 13) % 200),
  discount: (base) => 1_000 - base,
  days: (_, i) => (i * 7) % 30,
  weight: (base, i) => base / 2 + ((i * 11) % 100),
  rating: (_, i) => 1 + (i % 5),
  returns: (_, i) => (i * 17) % 50,
  // A name longer than the room past the last axis, which its window keeps whole.
  gross_margin: (base, i) => base * 2 - ((i * 19) % 300),
};
const parallelHeads = Object.keys(parallelColumns);
const parallelRows = Array.from({ length: 1_000 }, (_, i) =>
  Object.values(parallelColumns)
    .map((of) => of((i * 37) % 997, i))
    .join(","),
);
await writeFile(parallelFile, `${[parallelHeads.join(","), ...parallelRows].join("\n")}\n`);
const paralleled = join(scratch, "sent", "paralleled.uno");
const parallelSource = {
  ...spreadSource,
  id: "paralleled",
  name: "parallel.csv",
  path: parallelFile,
  rows: parallelRows.length,
  cols: parallelHeads.length,
};
const axesOf = (count) => parallelHeads.slice(0, count).map((header, col) => ({ col, header }));
const parallelChart = { source: parallelSource.id, title: "", refresh: 0 };
await writeFile(
  paralleled,
  writeDocument({
    manifest: newManifest(),
    sources: [parallelSource],
    active: parallelSource.id,
    log: [],
    charts: [
      {
        ...parallelChart,
        id: "c1",
        plot: { t: "parallel", axes: axesOf(4) },
        place: { ...chartSize, x: 1, y: 1 },
      },
      {
        ...parallelChart,
        id: "c2",
        plot: { t: "parallel", axes: axesOf(parallelHeads.length) },
        place: { ...chartSize, width: leastSize.width, x: 0, y: 0 },
      },
    ],
    extra: new Map(),
    at: paralleled,
  }),
);

// A workspace of two chord charts of an export of flights between nine
// airports, each way: the six with the most flights out and in and Other, in
// a new window's size at the sheet's foot on the right, and in a window of the
// least size at its top on the left. Each pair's flights grow with how busy
// both airports are, a little more from the busier, so every ribbon differs.
const chordFile = join(scratch, "sent", "flights.csv");
const chordBusy = { ORD: 9, ATL: 8, DEN: 7, LAX: 6, JFK: 5, SFO: 4, SEA: 2, BOS: 2, MIA: 1 };
const chordRows = Object.entries(chordBusy).flatMap(([from, out], i) =>
  Object.entries(chordBusy).flatMap(([to, into], j) =>
    i === j ? [] : Array.from({ length: out * into + (i < j ? out : 0) }, () => `${from},${to}`),
  ),
);
await writeFile(chordFile, `${["origin,dest", ...chordRows].join("\n")}\n`);
const chorded = join(scratch, "sent", "chorded.uno");
const chordSource = {
  ...spreadSource,
  id: "chorded",
  name: "flights.csv",
  path: chordFile,
  rows: chordRows.length,
  cols: 2,
};
const chordChart = {
  source: chordSource.id,
  title: "",
  refresh: 0,
  plot: { t: "chord", from: { col: 0, header: "origin" }, to: { col: 1, header: "dest" } },
};
await writeFile(
  chorded,
  writeDocument({
    manifest: newManifest(),
    sources: [chordSource],
    active: chordSource.id,
    log: [],
    charts: [
      { ...chordChart, id: "c1", place: { ...chartSize, x: 1, y: 1 } },
      { ...chordChart, id: "c2", place: { ...leastSize, x: 0, y: 0 } },
    ],
    extra: new Map(),
    at: chorded,
  }),
);

// A workspace of two dot plots of an export of five carriers' delivery days,
// their means a few tenths apart and Eagle's no number at all: the mean per
// carrier in a new window's size at the sheet's foot, and the same in a
// window of the least width at its top.
const dottedFile = join(scratch, "sent", "dotted.csv");
const dottedDays = {
  Acme: [3.3, 3.5],
  Bolt: [3, 3.2],
  Crane: [3.2, 3.3],
  Dart: [2.8, 3],
  Eagle: ["n/a"],
};
const dottedRows = Object.entries(dottedDays).flatMap(([carrier, days]) =>
  days.map((d) => `${carrier},${d}`),
);
await writeFile(dottedFile, `${["carrier,days", ...dottedRows].join("\n")}\n`);
const dotted = join(scratch, "sent", "dotted.uno");
const dottedSource = {
  ...spreadSource,
  id: "dotted",
  name: "dotted.csv",
  path: dottedFile,
  rows: dottedRows.length,
  cols: 2,
};
const dottedPlot = {
  t: "dots",
  by: { col: 0, header: "carrier" },
  of: { col: 1, header: "days" },
  measure: "mean",
};
const dottedChart = { source: dottedSource.id, title: "", refresh: 0, plot: dottedPlot };
await writeFile(
  dotted,
  writeDocument({
    manifest: newManifest(),
    sources: [dottedSource],
    active: dottedSource.id,
    log: [],
    charts: [
      { ...dottedChart, id: "c1", place: { ...chartSize, x: 0, y: 1 } },
      { ...dottedChart, id: "c2", place: { ...chartSize, width: leastSize.width, x: 1, y: 0 } },
    ],
    extra: new Map(),
    at: dotted,
  }),
);

// A workspace of two slope charts of an export of four regions' revenue over
// three years: North and East rise from 2024 to 2025, South falls, and West
// has no row in 2025; 2023's rows stand in neither state. The sum of revenue
// per region from 2024 to 2025 in a new window's size at the sheet's foot,
// and the same in a window of the least width at its top.
const slopedFile = join(scratch, "sent", "sloped.csv");
const slopedRevenue = {
  North: [90, 100, 140],
  South: [210, 200, 150],
  East: [70, 80, 90],
  West: [160, 150],
};
const slopedYears = ["2023", "2024", "2025"];
const slopedRows = Object.entries(slopedRevenue).flatMap(([region, revenue]) =>
  revenue.map((r, i) => `${region},${slopedYears[i]},${r}`),
);
await writeFile(slopedFile, `${["region,year,revenue", ...slopedRows].join("\n")}\n`);
const sloped = join(scratch, "sent", "sloped.uno");
const slopedSource = {
  ...spreadSource,
  id: "sloped",
  name: "sloped.csv",
  path: slopedFile,
  rows: slopedRows.length,
  cols: 3,
};
const slopedPlot = {
  t: "slope",
  by: { col: 0, header: "region" },
  between: { col: 1, header: "year" },
  from: "2024",
  to: "2025",
  of: { col: 2, header: "revenue" },
  measure: "sum",
};
const slopedChart = { source: slopedSource.id, title: "", refresh: 0, plot: slopedPlot };
await writeFile(
  sloped,
  writeDocument({
    manifest: newManifest(),
    sources: [slopedSource],
    active: slopedSource.id,
    log: [],
    charts: [
      { ...slopedChart, id: "c1", place: { ...chartSize, x: 0, y: 1 } },
      { ...slopedChart, id: "c2", place: { ...chartSize, width: leastSize.width, x: 1, y: 0 } },
    ],
    extra: new Map(),
    at: sloped,
  }),
);

// A workspace of two week heatmaps of an export of four weeks of orders from
// Sunday 3 March 2024: on weekdays from 09:00 to 17:00, most at 13:00, and one
// each weekend evening at 20:00, each order worth 100 and a Sunday evening's a
// return of 300. Rows per hour of the week in a new window's size at the
// sheet's foot, and the sum of revenue in a window of the least width at its
// top, its Sunday evenings below zero.
const weeklyFile = join(scratch, "sent", "weekly.csv");
const weeklyDays = 28;
const [weeklyOpens, weeklyPeak, weeklyCloses, weeklyEvening] = [9, 13, 17, 20];
const weeklyReturn = -300;
const weeklyRows = Array.from({ length: weeklyDays }, (_, d) => d).flatMap((d) => {
  const day = new Date(Date.UTC(2024, 2, 3 + d));
  const weekday = day.getUTCDay();
  const date = day.toISOString().slice(0, 10);
  const at = (hour, revenue) => `${date} ${String(hour).padStart(2, "0")}:15,${revenue}`;
  if (weekday === 0 || weekday === 6)
    return [at(weeklyEvening, weekday === 0 ? weeklyReturn : 100)];
  return Array.from({ length: weeklyCloses - weeklyOpens + 1 }, (_, i) => weeklyOpens + i).flatMap(
    (hour) => Array.from({ length: 5 - Math.abs(hour - weeklyPeak) }, () => at(hour, 100)),
  );
});
await writeFile(weeklyFile, `${["ordered,revenue", ...weeklyRows].join("\n")}\n`);
const weekly = join(scratch, "sent", "weekly.uno");
const weeklySource = {
  ...spreadSource,
  id: "weekly",
  name: "weekly.csv",
  path: weeklyFile,
  rows: weeklyRows.length,
  cols: 2,
};
const weeklyPlot = { t: "week", at: { col: 0, header: "ordered" }, order: "day" };
const weeklyChart = { source: weeklySource.id, title: "", refresh: 0 };
await writeFile(
  weekly,
  writeDocument({
    manifest: newManifest(),
    sources: [weeklySource],
    active: weeklySource.id,
    log: [],
    charts: [
      { ...weeklyChart, id: "c1", plot: weeklyPlot, place: { ...chartSize, x: 0, y: 1 } },
      {
        ...weeklyChart,
        id: "c2",
        plot: { ...weeklyPlot, sum: { col: 1, header: "revenue" } },
        place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
      },
    ],
    extra: new Map(),
    at: weekly,
  }),
);

// A workspace of a week heatmap of the same four weeks' orders by their day
// alone, written with no time, in a new window's size: a grid of days.
const dailyFile = join(scratch, "sent", "daily.csv");
const dailyRows = weeklyRows.map((r) => r.slice(0, "2024-03-03".length));
await writeFile(dailyFile, `${["ordered", ...dailyRows].join("\n")}\n`);
const daily = join(scratch, "sent", "daily.uno");
const dailySource = { ...weeklySource, id: "daily", name: "daily.csv", path: dailyFile, cols: 1 };
await writeFile(
  daily,
  writeDocument({
    manifest: newManifest(),
    sources: [dailySource],
    active: dailySource.id,
    log: [],
    charts: [
      {
        ...weeklyChart,
        source: dailySource.id,
        id: "c1",
        plot: weeklyPlot,
        place: { ...chartSize, x: 0, y: 1 },
      },
    ],
    extra: new Map(),
    at: daily,
  }),
);

// A workspace of two heatmaps over periods of a year of four regions' orders,
// one row an order on the 10th of a month at noon: North's orders grow a
// month at a time, South's fall, East's stay at 3 a month, and West orders
// once in June. Each order is worth 100, and East's in March are a return of
// 400 each. Rows per region per month in a new window's size at the sheet's
// foot, and the sum of revenue per region per month in a window of the least
// width at its top.
const heatedFile = join(scratch, "sent", "heated.csv");
const heatedMonths = 12;
const heatedRegions = {
  North: (m) => m + 1,
  South: (m) => heatedMonths - m,
  East: () => 3,
  West: (m) => (m === 5 ? 1 : 0),
};
const heatedReturnMonth = 2;
const heatedRows = Object.entries(heatedRegions).flatMap(([region, orders]) =>
  Array.from({ length: heatedMonths }, (_, m) => m).flatMap((m) => {
    const date = `2024-${String(m + 1).padStart(2, "0")}-10 12:00`;
    const revenue = region === "East" && m === heatedReturnMonth ? -400 : 100;
    return Array.from({ length: orders(m) }, () => `${region},${date},${revenue}`);
  }),
);
await writeFile(heatedFile, `${["region,ordered,revenue", ...heatedRows].join("\n")}\n`);
const heated = join(scratch, "sent", "heated.uno");
const heatedSource = {
  ...spreadSource,
  id: "heated",
  name: "heated.csv",
  path: heatedFile,
  rows: heatedRows.length,
  cols: 3,
};
const heatedPlot = {
  t: "heat",
  by: { col: 0, header: "region" },
  at: { col: 1, header: "ordered" },
  per: "month",
  order: "day",
};
const heatedChart = { source: heatedSource.id, title: "", refresh: 0 };
await writeFile(
  heated,
  writeDocument({
    manifest: newManifest(),
    sources: [heatedSource],
    active: heatedSource.id,
    log: [],
    charts: [
      { ...heatedChart, id: "c1", plot: heatedPlot, place: { ...chartSize, x: 0, y: 1 } },
      {
        ...heatedChart,
        id: "c2",
        plot: { ...heatedPlot, sum: { col: 2, header: "revenue" } },
        place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
      },
    ],
    extra: new Map(),
    at: heated,
  }),
);

// A workspace of two horizon charts of the same year of four regions' orders:
// rows per region per month in a new window's size at the sheet's foot, and
// the sum of revenue per month alone in a window of the least width at its top.
const horizons = join(scratch, "sent", "horizons.uno");
const horizonPlot = { ...heatedPlot, t: "horizon" };
const { by: _by, ...horizonAlone } = horizonPlot;
await writeFile(
  horizons,
  writeDocument({
    manifest: newManifest(),
    sources: [heatedSource],
    active: heatedSource.id,
    log: [],
    charts: [
      { ...heatedChart, id: "c1", plot: horizonPlot, place: { ...chartSize, x: 0, y: 1 } },
      {
        ...heatedChart,
        id: "c2",
        plot: { ...horizonAlone, sum: { col: 2, header: "revenue" } },
        place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
      },
    ],
    extra: new Map(),
    at: horizons,
  }),
);

// A workspace of two stacked charts of a small export of four regions' sales
// in eight channels, each channel's rows fewer than the one before it and
// each region's more than the one before it: rows per region by channel in a
// new window's size at the sheet's foot, whose six largest channels take a
// colour each and the last two Other, and the sum of revenue per region by
// channel in a window of the least width at its top. The fair's revenue is
// what it paid back, below zero, so each bar of sums has a part left of zero.
const stackedFile = join(scratch, "sent", "stacked.csv");
const stackedHeader = "region,channel,revenue";
const stackedRegions = ["North", "South", "East", "West"];
const stackedChannels = ["web", "direct", "partner", "mail", "phone", "shop", "fair", "kiosk"];
const stackedReturns = "fair";
const stackedRows = stackedRegions.flatMap((region, r) =>
  stackedChannels.flatMap((channel, c) => {
    const revenue = (channel === stackedReturns ? -1 : 1) * (c + 1) * 100;
    return Array.from(
      { length: stackedChannels.length - c + r },
      () => `${region},${channel},${revenue}`,
    );
  }),
);
await writeFile(stackedFile, `${[stackedHeader, ...stackedRows].join("\n")}\n`);
const stacked = join(scratch, "sent", "stacked.uno");
const stackedSource = {
  id: "stacked",
  name: "stacked.csv",
  path: stackedFile,
  rows: stackedRows.length,
  cols: stackedHeader.split(",").length,
  state: { active: { row: 0, col: 0 } },
};
const perRegion = {
  t: "stack",
  by: { col: 0, header: "region" },
  split: { col: 1, header: "channel" },
};
const stackedChart = { source: stackedSource.id, title: "", refresh: 0 };
// The same workspace again, whose bars the moving checks move and save, so
// they open a workspace of their own and leave the stacked one as it was.
const movable = join(scratch, "sent", "movable.uno");
for (const at of [stacked, movable]) {
  await writeFile(
    at,
    writeDocument({
      manifest: newManifest(),
      sources: [stackedSource],
      active: stackedSource.id,
      log: [],
      charts: [
        { ...stackedChart, id: "c1", plot: perRegion, place: { ...chartSize, x: 0, y: 1 } },
        {
          ...stackedChart,
          id: "c2",
          plot: { ...perRegion, sum: { col: 2, header: "revenue" } },
          place: { ...chartSize, width: leastSize.width, x: 1, y: 0 },
        },
      ],
      extra: new Map(),
      at,
    }),
  );
}

// A workspace of rows over the dates of a file whose last is a placeholder,
// 9999-12-31, in a new window's size. Its 7,976 years are past the batch a
// tally sends, so the window asks for the rest. It stands at the sheet's
// foot, clear of the selected cell.
const placedFile = join(scratch, "sent", "placeholders.csv");
const placedRows = ["2024-03-04", "2024-03-05", "2025-01-10", "9999-12-31"];
await writeFile(placedFile, `${["date", ...placedRows].join("\n")}\n`);
const placed = join(scratch, "sent", "placeholders.uno");
const placedSource = {
  id: "placeholders",
  name: "placeholders.csv",
  path: placedFile,
  rows: placedRows.length,
  cols: 1,
  state: { active: { row: 0, col: 0 } },
};
const placedOver = { t: "time", at: { col: 0, header: "date" }, per: "auto", order: "day" };
await writeFile(
  placed,
  writeDocument({
    manifest: newManifest(),
    sources: [placedSource],
    active: placedSource.id,
    log: [],
    charts: [
      {
        id: "c1",
        source: placedSource.id,
        plot: placedOver,
        title: "",
        refresh: 0,
        place: { ...chartSize, x: 1, y: 1 },
      },
    ],
    extra: new Map(),
    at: placed,
  }),
);

// A workspace of pies of the second export's rows, in a new window's size: one
// per Location, which it writes four ways, and one per Device, which it writes
// nine, so its six largest have a slice each and the rest an Other. A third,
// per Device in a window of the least size, has too little room to label them.
const pies = join(scratch, "sent", "pies.uno");
const adsSource = {
  id: "ads",
  name: "google-ads-sales.csv",
  path: second,
  rows: 2600,
  cols: 13,
  state: { active: { row: 0, col: 0 } },
};
const shareOf = (col, header) => ({ t: "pie", by: { col, header } });
const pieChart = { source: adsSource.id, title: "", refresh: 0 };
await writeFile(
  pies,
  writeDocument({
    manifest: newManifest(),
    sources: [adsSource],
    active: adsSource.id,
    log: [],
    charts: [
      { ...pieChart, id: "c1", plot: shareOf(10, "Location"), place: { ...chartSize, x: 0, y: 0 } },
      { ...pieChart, id: "c2", plot: shareOf(11, "Device"), place: { ...chartSize, x: 1, y: 0 } },
      { ...pieChart, id: "c3", plot: shareOf(11, "Device"), place: { ...leastSize, x: 1, y: 1 } },
    ],
    extra: new Map(),
    at: pies,
  }),
);

// A workspace of rows over the second export's Ad_Date read month first. It
// writes 551 of its dates day first past the 12th, which month first cannot
// read, the first in its second row.
const misread = join(scratch, "sent", "misread.uno");
const monthFirst = { t: "time", at: { col: 9, header: "Ad_Date" }, per: "auto", order: "month" };
await writeFile(
  misread,
  writeDocument({
    manifest: newManifest(),
    sources: [adsSource],
    active: adsSource.id,
    log: [],
    charts: [
      {
        id: "c1",
        source: adsSource.id,
        plot: monthFirst,
        title: "",
        refresh: 0,
        place: { ...chartSize, x: 1, y: 1 },
      },
    ],
    extra: new Map(),
    at: misread,
  }),
);

// A workspace of three charts over what a chart cannot read: a source in a
// bucket no connection covers, one whose file is not there, and a column the
// second export has not. The first two sources have no rows behind them.
const states = join(scratch, "sent", "states.uno");
const absent = { bytes: 0, rows: 0, cols: 0, state: { active: { row: 0, col: 0 } } };
const waitingSource = {
  ...absent,
  id: "waiting",
  name: "waiting.csv",
  path: "s3://nobody-connected/2025/waiting.csv",
};
const lostSource = {
  ...absent,
  id: "lost",
  name: "lost.csv",
  path: join(scratch, "sent", "lost.csv"),
};
const rowsPer = (source, col, header) => ({
  source,
  plot: { t: "bars", by: { col, header } },
  title: "",
  refresh: 0,
});
// The column the second export has not: the one past its last.
const gone = adsSource.cols;
await writeFile(
  states,
  writeDocument({
    manifest: newManifest(),
    sources: [adsSource, waitingSource, lostSource],
    active: adsSource.id,
    log: [],
    charts: [
      { ...rowsPer("waiting", 0, "date"), id: "c1", place: { ...chartSize, x: 0, y: 0 } },
      { ...rowsPer("lost", 0, "date"), id: "c2", place: { ...chartSize, x: 1, y: 0 } },
      { ...rowsPer("ads", gone, "Nowhere"), id: "c3", place: { ...chartSize, x: 0.5, y: 1 } },
    ],
    extra: new Map(),
    at: states,
  }),
);

// A workspace of bars of the second export's rows per Conversions, whose cell
// is blank in 74 rows, in a window tall enough for all nine of its values, by
// the sheet's right edge, clear of its first cell.
const blanks = join(scratch, "sent", "blanks.uno");
const conversions = rowsPer(adsSource.id, 6, "Conversions");
const tall = { ...chartSize, height: 2 * chartSize.height, x: 1, y: 0 };
await writeFile(
  blanks,
  writeDocument({
    manifest: newManifest(),
    sources: [adsSource],
    active: adsSource.id,
    log: [],
    charts: [{ ...conversions, id: "c1", place: tall }],
    extra: new Map(),
    at: blanks,
  }),
);

// A workspace of one chart that checks its file every minute, the shortest
// schedule, over a file of two rows. A check asks for a third, and the chart
// draws it once the minute is up, which may take a check's own limit more.
const everyMinute = 1;
const scheduledFile = join(scratch, "sent", "scheduled.csv");
const scheduledHeader = "region";
const scheduledRows = ["North", "South"];
const grownRow = "West";
await writeFile(scheduledFile, `${[scheduledHeader, ...scheduledRows].join("\n")}\n`);
const scheduled = join(scratch, "sent", "scheduled.uno");
const scheduledSource = {
  id: "scheduled",
  name: "scheduled.csv",
  path: scheduledFile,
  rows: scheduledRows.length,
  cols: 1,
  state: { active: { row: 0, col: 0 } },
};
const scheduledChart = { ...rowsPer(scheduledSource.id, 0, scheduledHeader), refresh: everyMinute };
await writeFile(
  scheduled,
  writeDocument({
    manifest: newManifest(),
    sources: [scheduledSource],
    active: scheduledSource.id,
    log: [],
    charts: [{ ...scheduledChart, id: "c1", place: { ...chartSize, x: 0, y: 0 } }],
    extra: new Map(),
    at: scheduled,
  }),
);

requireElectron("smoke");
const electron = (await import("electron")).default;

requireDisplay("smoke");

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

/** How long a second uno gets to find the first and exit. */
const AGAIN_MS = 15_000;

/**
 * again starts a second uno on the same user data folder, on `path` if one
 * is given, and resolves to whether it exited cleanly: it found the first
 * holding the lock, handed its line over and quit. One still running at
 * AGAIN_MS opened a window of its own, and is killed.
 *
 * @param {string | undefined} path
 * @returns {Promise<boolean>}
 */
function again(path) {
  const child = spawn(
    electron,
    [pkg, `--user-data-dir=${data}`, DRIVEN_LANGUAGE_SWITCH, ...(path === undefined ? [] : [path])],
    { stdio: ["ignore", "inherit", "inherit"], env: electronEnv(process.env, DRIVEN_LANGUAGE_ENV) },
  );
  return new Promise((resolve) => {
    const late = setTimeout(() => child.kill("SIGKILL"), AGAIN_MS);
    child.on("close", (code) => {
      clearTimeout(late);
      resolve(code === 0);
    });
  });
}

/**
 * answer handles what a check asks of this script: `rewrite <key>` rewrites
 * the object at <key> with one digit changed, `put <key> ...` puts the
 * objects held in ARRIVING for those keys into the bucket, `again [<path>]`
 * starts a second uno and waits for it to exit, and `grow` adds a row to the
 * scheduled chart's file.
 */
function answer(what) {
  const [verb, ...keys] = what.split(" ");
  if (verb === "grow" && keys.length === 0) {
    return appendFile(scheduledFile, `${grownRow}\n`).then(() => true);
  }
  if (verb === "again" && keys.length <= 1) return again(keys[0]);
  if (verb === "put" && keys.length > 0 && keys.every((k) => ARRIVING.has(k))) {
    for (const k of keys) standin.objects.set(k, ARRIVING.get(k));
    return true;
  }
  const [key] = keys;
  if (verb !== "rewrite" || !standin.objects.has(key ?? "")) return false;
  rewrite(standin.objects, key);
  return true;
}

/**
 * run drives one uno over the groups `only` names, with `folder` as its
 * screenshots' and its data's, and resolves to its verdict, or undefined.
 *
 * @param {string[]} only
 * @param {string} folder
 * @param {number} deadlineMs
 */
async function run(only, folder, deadlineMs) {
  const dataDir = join(folder, "data");
  await rm(dataDir, { recursive: true, force: true });
  const { code, out } = await drive("smoke", {
    electron,
    args: [pkg, `--user-data-dir=${dataDir}`, DRIVEN_LANGUAGE_SWITCH, fixture],
    env: electronEnv(process.env, {
      ...DRIVEN_LANGUAGE_ENV,
      UNO_SMOKE: folder,
      [ONLY_VARIABLE]: only.join(","),
      UNO_SMOKE_SOURCE: second,
      // The object's address, for the check that adds it.
      UNO_SMOKE_OBJECT: object,
      UNO_SMOKE_SENT: sent,
      UNO_SMOKE_CHARTED: charted,
      UNO_SMOKE_SIGNED: signed,
      UNO_SMOKE_SCATTERED: scattered,
      UNO_SMOKE_ALONG: along,
      UNO_SMOKE_PIES: pies,
      UNO_SMOKE_TIMED: timed,
      UNO_SMOKE_STACKED: stacked,
      UNO_SMOKE_SPREAD: spread,
      UNO_SMOKE_BOXED: boxed,
      UNO_SMOKE_SWARMED: swarmed,
      UNO_SMOKE_PARALLELED: paralleled,
      UNO_SMOKE_CHORDED: chorded,
      UNO_SMOKE_DOTTED: dotted,
      UNO_SMOKE_SLOPED: sloped,
      UNO_SMOKE_WEEKLY: weekly,
      UNO_SMOKE_DAILY: daily,
      UNO_SMOKE_HEATED: heated,
      UNO_SMOKE_HORIZONS: horizons,
      UNO_SMOKE_MOVABLE: movable,
      UNO_SMOKE_PLACED: placed,
      UNO_SMOKE_MISREAD: misread,
      UNO_SMOKE_STATES: states,
      UNO_SMOKE_BLANKS: blanks,
      UNO_SMOKE_SCHEDULED: scheduled,
      // What the + at the foot of the sidebar opens, in place of the Open dialog.
      UNO_DRIVEN_OPEN: second,
      // The stand-in's endpoint and keys. The engine's utility process inherits
      // the app's environment.
      ...standinEnv(standin),
      AWS_CONFIG_FILE: join(aws, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(aws, "credentials"),
    }),
    answer,
    // Each check's, from the line the app prints as it begins one.
    deadlineMs,
    onTimeout: () => void shut(),
  });
  return verdict("smoke", code, out, "smoke: all checks passed");
}

// The schedule's group waits on the clock for its minute, longer than every
// other check together, so it runs in a second uno beside the rest, with a
// folder of its own. Which groups run is UNO_SMOKE_ONLY's choice, each with
// the groups it leans on; see src/main/smoke/groups.ts.
const groups = selected(GROUPS, process.env[ONLY_VARIABLE]).map((g) => g.name);
const rest = groups.filter((name) => name !== SCHEDULE);
const aside = join(scratch, "schedule");
await mkdir(aside, { recursive: true });
const verdicts = await Promise.all([
  rest.length > 0 ? run(rest, scratch, 60_000 + CHECK_TIMEOUT_MS) : undefined,
  groups.includes(SCHEDULE)
    ? run([SCHEDULE], aside, 60_000 + everyMinute * MINUTE_MS + CHECK_TIMEOUT_MS)
    : undefined,
]);
await shut();
const failed = verdicts.filter((v) => v !== undefined);
if (failed.length > 0) {
  for (const line of failed) console.error(line);
  process.exit(1);
}

// The saved .uno, read with the same reader the engine opens a workspace
// with. Only here can the file on disk be checked.
// What the run left is read back for the groups that ran. A run of some
// groups (UNO_SMOKE_ONLY, see src/main/smoke/groups.ts) leaves only theirs.
/** Every check both unos ran, read back from each one's folder. */
const checks = [];
for (const folder of [scratch, aside]) {
  if (existsSync(join(folder, "checks.json"))) {
    checks.push(...JSON.parse(await readFile(join(folder, "checks.json"), "utf8")));
  }
}
await writeFile(join(scratch, "checks.json"), JSON.stringify(checks));
const ran = new Set(checks.map((check) => check.group));
const trouble = [];
const written = (await readdir(scratch)).filter((name) => name.endsWith(".uno"));
const saved = written[0];
if (saved === undefined && ran.has("sources")) {
  console.error(`smoke: FAILED (no .uno was written under ${scratch})`);
  console.error("smoke: the run has to save the workspace before it quits -- see src/main/smoke/");
  process.exit(1);
}

const pointers = [];
if (saved !== undefined) {
  const at = join(scratch, saved);
  const doc = readContainer(saved, await readFile(at), at);
  for (const s of doc.manifest.sources) {
    pointers.push({ name: s.name, path: s.path, version: s.version, connection: s.connection });
  }
}

const remote = pointers.find((s) => s.path === object);
if (saved === undefined) {
  // Nothing to read back: the group that saves did not run.
} else if (remote === undefined) {
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
if (saved === undefined) {
  // As above.
} else if (local === undefined) trouble.push(`${saved} holds no sales-q3.csv`);
else if (local.path !== fixture) {
  trouble.push(`sales-q3.csv points at ${JSON.stringify(local.path)}, not the absolute ${fixture}`);
}

// The connection the checks saved, read back from the disk: in the run's own
// folder, parses as a connection, and signs in by profile.
const kept = join(data, "connections", "acme-exports.unof");
if (ran.has("connections"))
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

// The charted workspace, which the last checks saved with Ctrl+S after moving
// its first window. That window ends on the room's right edge at the least
// height, a nudge wide of the least width and a nudge up from the foot. The
// second never moved.
if (ran.has("chart-moves")) {
  const chartsBack = readContainer("charted.uno", await readFile(charted), charted).charts;
  const [firstBack, lastBack] = chartsBack.map((chart) => chart.place);
  const standsAt = (place, want) => Object.keys(want).every((side) => place[side] === want[side]);
  const nudgedUp = firstBack.y > 0 && firstBack.y < 1;
  const stepped = { x: 1, width: leastSize.width + nudge, height: leastSize.height };
  if (!nudgedUp || !standsAt(firstBack, stepped)) {
    trouble.push(`the moved window was saved at ${JSON.stringify(firstBack)}`);
  }
  if (!standsAt(lastBack, { ...chartSize, x: 1, y: 1 })) {
    trouble.push(`the window left alone was saved at ${JSON.stringify(lastBack)}`);
  }
}

if (trouble.length > 0) {
  for (const line of trouble) console.error(`smoke: FAILED (${line})`);
  process.exit(1);
}

if (saved !== undefined) {
  console.log(`smoke: ${saved} points at ${pointers.map((s) => s.path).join(", ")}`);
}
if (ran.has("connections")) console.log(`smoke: ${kept} reads back as a connection to ${BUCKET}`);
console.log("smoke: ok");
