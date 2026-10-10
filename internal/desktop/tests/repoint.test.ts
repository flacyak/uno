// A missing S3 source, re-pointed at another object from the panel, with its
// edits replayed.
//
// Runs headless over a real engine, the S3 provider, and the stand-in
// bucket. A workspace is saved pointing at an object, the object is deleted,
// and the workspace opens with the source missing. The panel browses the
// object's prefix through the workspace's engine, and the file picked there
// is what the workspace is pointed at.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { HOME_REGION } from "../../grid/tests/store/regions.ts";
import { bucket, etagOf } from "../../grid/tests/store/standin.ts";
import type { Bucket } from "../../grid/tests/store/standin.ts";
import { bucketEngine } from "./bucket-engine.ts";
import { Sources, stateOf } from "../src/renderer/sources.ts";
import { Workspace } from "../src/renderer/workspace.ts";

/** A small export, and the index of its cost column. */
const ADS = "Ad_Date,Cost\n2024-11-16,$12.50\n20-11-2024,$8.00\n2024/11/16,$3.10\n";
const COST = 1;

const enc = new TextEncoder();

let b: Bucket;
let dir: string;

beforeAll(async () => {
  b = await bucket(
    undefined,
    HOME_REGION,
    new Map([
      ["ads/google-ads.csv", enc.encode(ADS)],
      // The same export under another name.
      ["ads/google-ads-v2.csv", enc.encode(ADS)],
      // A header alone. The edit's row is past its end.
      ["ads/empty.csv", enc.encode("Ad_Date,Cost\n")],
    ]),
  );
  dir = await mkdtemp(join(tmpdir(), "uno-repoint-"));
});

afterAll(async () => {
  await b.close();
  await rm(dir, { recursive: true, force: true });
});

function open(path: string): Promise<Workspace> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return Workspace.open(
    { name, path },
    bucketEngine(b),
    path,
    () => {},
    () => {},
  );
}

test("a missing S3 source is re-pointed at another object, and its edits replay", async () => {
  const saved = join(dir, "ads.uno");

  // An edit to the object, saved as a workspace that points at it.
  const first = await open("s3://acme-exports/ads/google-ads.csv");
  try {
    first.transform();
    await first.set(0, COST, "12.50");
    await writeFile(saved, await first.bytes({ row: 0, col: COST }, saved));
  } finally {
    first.close();
  }
  b.objects.delete("ads/google-ads.csv");

  const w = await open(saved);
  try {
    const gone = w.active;
    expect(stateOf(gone)).toBe("missing");
    expect(gone.edited, "the edit is kept while there is no file under it").toBe(1);

    // The panel over this workspace, as the shell makes it.
    const panel = new Sources(w, () => w.sources);
    panel.focus("workspace");
    expect(panel.doings.map((a) => a.does)).toEqual(["reload", "repoint"]);

    await panel.repoint(gone);
    expect(panel.crumb.map((c) => c.path)).toEqual(["s3://acme-exports", "s3://acme-exports/ads/"]);
    expect(panel.entries.map((e) => e.name)).toEqual(["empty.csv", "google-ads-v2.csv"]);

    // An object too short for the log is refused, and the tab stays as it was.
    await panel.toggle(panel.entries[0]!);
    await expect(w.relink(gone, panel.buttons[0]!.refs[0]!)).rejects.toThrow(/empty\.csv/);
    expect(w.active).toBe(gone);

    await panel.toggle(panel.entries[1]!);
    const [point] = panel.buttons;
    expect(point?.label).toBe("Point google-ads.csv here");
    expect(point?.to).toBe(gone.id);

    const back = await w.relink(gone, point!.refs[0]!);
    panel.stop();

    expect(back.id, "the id the log names is the one it keeps").toBe(gone.id);
    expect(back.link).toEqual({
      path: "s3://acme-exports/ads/google-ads-v2.csv",
      version: etagOf(enc.encode(ADS)),
    });
    expect(stateOf(back)).toBe("fine");
    expect(back.edited).toBe(1);
    expect((await back.source.rows(0, 3)).rows.map((r) => r[COST])).toEqual([
      "12.50",
      "$8.00",
      "$3.10",
    ]);
    // Re-pointed, the workspace is dirty until saved.
    expect(w.dirty).toBe(true);
    expect(panel.repointing).toBeUndefined();

    // Saved, the workspace points at the new object.
    await writeFile(saved, await w.bytes({ row: 0, col: COST }, saved));
  } finally {
    w.close();
  }

  const again = await open(saved);
  try {
    expect(stateOf(again.active)).toBe("fine");
    expect(again.active.link?.path).toBe("s3://acme-exports/ads/google-ads-v2.csv");
    expect(again.active.edited).toBe(1);
  } finally {
    again.close();
  }
});
