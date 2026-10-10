// Newer in the bucket, and Reload. askNewer sends one HEAD per tab reading an
// object, and marks a tab whose object has a new version. Reload reads the
// newer version.
//
// Runs over the real engine and the stand-in bucket.

import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { bucket, etagOf } from "../../grid/tests/store/standin.ts";
import type { Bucket } from "../../grid/tests/store/standin.ts";
import { m } from "../src/paraglide/messages.js";
import { bucketEngine } from "./bucket-engine.ts";
import { stateOf, stateWord } from "../src/renderer/sources.ts";
import { Workspace, reloaded } from "../src/renderer/workspace.ts";

const ADS = "Ad_Date,Cost\n2024-11-16,$12.50\n2024-11-17,$8.00\n";
/** The same export with one figure changed, at the same size. */
const ADS_AGAIN = "Ad_Date,Cost\n2024-11-16,$12.50\n2024-11-17,$9.00\n";
const KEY = "ads/google-ads.csv";
const OBJECT = `s3://acme-exports/${KEY}`;

const enc = new TextEncoder();

let b: Bucket;
let dir: string;

beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, new Map());
  dir = await mkdtemp(join(tmpdir(), "uno-newer-"));
});
afterAll(async () => {
  await b.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  b.objects.set(KEY, enc.encode(ADS));
});

/** A workspace of the object and a file on disk beside it. */
async function both(): Promise<Workspace> {
  const w = await Workspace.open(
    { name: "google-ads.csv", path: OBJECT },
    bucketEngine(b),
    OBJECT,
    () => {},
    () => {},
  );
  const local = join(dir, "local.csv");
  await writeFile(local, ADS);
  await w.add({ name: "local.csv", path: local });
  return w;
}

/** The HEADs that reached the object since b.seen was last cleared. */
const heads = (): number =>
  b.seen.filter((s) => s.method === "HEAD" && s.path.endsWith(KEY)).length;

// Replacing the object is seen on the next askNewer.
test("replacing the object in the bucket marks its tab on the next ask", async () => {
  const w = await both();
  try {
    const remote = w.sources.find((t) => t.name === "google-ads.csv")!;
    b.seen.length = 0;
    expect(await w.askNewer(), "nothing has moved").toBe(false);
    expect(remote.newer).toBeUndefined();
    // One HEAD for the object, and none for the file on disk.
    expect(heads()).toBe(1);
    expect(b.seen).toHaveLength(1);

    b.objects.set(KEY, enc.encode(ADS_AGAIN));
    expect(await w.askNewer()).toBe(true);
    expect(remote.newer).toBe(etagOf(enc.encode(ADS_AGAIN)));
    expect(stateOf(remote)).toBe("newer");
    expect(stateWord("newer")).toBe("newer in bucket");
    w.show(remote);
    expect(w.status()).toContain(m.newer_version());

    // Asked again while the bucket is unchanged, the mark stays and askNewer
    // is false.
    expect(await w.askNewer()).toBe(false);
    expect(remote.newer).toBeDefined();

    // Put back, the mark goes.
    b.objects.set(KEY, enc.encode(ADS));
    expect(await w.askNewer()).toBe(true);
    expect(stateOf(remote)).toBe("fine");
  } finally {
    w.close();
  }
});

// A failed HEAD leaves the tab as it was.
test("a HEAD that fails leaves the tab as it was", async () => {
  const w = await both();
  try {
    const remote = w.sources.find((t) => t.name === "google-ads.csv")!;
    b.objects.set(KEY, enc.encode(ADS_AGAIN));
    await w.askNewer();
    expect(remote.newer).toBeDefined();
    b.objects.delete(KEY);
    expect(await w.askNewer()).toBe(false);
    expect(remote.newer).toBeDefined();
  } finally {
    w.close();
  }
});

// Reload is an unversioned relink at the same URL, so it reads what the
// bucket holds now. The edits replay on the new bytes.
test("Reload reads the newer version, lands the edits on it, and says what changed", async () => {
  const w = await both();
  try {
    const remote = w.sources.find((t) => t.name === "google-ads.csv")!;
    w.show(remote);
    w.transform();
    await w.set(0, 0, "2024-11-15");

    b.objects.set(KEY, enc.encode(ADS_AGAIN));
    await w.askNewer();
    expect(stateOf(remote)).toBe("newer");

    const fresh = await w.relink(remote, { name: "google-ads.csv", path: OBJECT });
    expect(fresh.link).toEqual({ path: OBJECT, version: etagOf(enc.encode(ADS_AGAIN)) });
    expect(fresh.newer).toBeUndefined();
    expect(stateOf(fresh)).toBe("fine");
    // The new bytes hold the changed figure and the replayed edit.
    const rows = (await fresh.source.rows(0, 2)).rows;
    expect(rows[0]![0]).toBe("2024-11-15");
    expect(rows[1]![1]).toBe("$9.00");
    expect(reloaded(remote, fresh)).toBe(
      "reloaded google-ads.csv · a new version, the same size · 1 edit replayed",
    );
    // The tab is at the latest version.
    expect(await w.askNewer()).toBe(false);
    expect(fresh.newer).toBeUndefined();
  } finally {
    w.close();
  }
});

test("Reload of an object nobody touched says so", async () => {
  const w = await both();
  try {
    const remote = w.sources.find((t) => t.name === "google-ads.csv")!;
    const fresh = await w.relink(remote, { name: "google-ads.csv", path: OBJECT });
    expect(reloaded(remote, fresh)).toBe("reloaded google-ads.csv · no change in the bucket");
  } finally {
    w.close();
  }
});
