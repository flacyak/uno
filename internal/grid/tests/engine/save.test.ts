// The engine and a .uno: opening one with its log applied, saving back, and a
// workspace of several sources.

import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { LOG_ENTRY, newManifest, readDocument, writeDocument } from "../../src/document/index.ts";
import type { Document } from "../../src/document/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { read } from "../../src/ingest/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { COLS, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, bytes, connect, indexed, openOne } from "./harness.ts";

/** A save limit the 240 KB fixture fits under, and one it does not. */
const ROOMY = 1 << 20;
const CRAMPED = 1 << 10;

/** A second export, small and of another shape, for a workspace of two. */
const ADS = "Ad_Date,Cost\n2024-11-16,$12.50\n20-11-2024,$8.00\n2024/11/16,$3.10\n";
const ADS_ROWS = 3;
const COST = 1;

/** Where a save should leave one source, and that it was showing. */
function at(source: SourceHandle, row: number, col: number) {
  return { source: source.id, cells: [{ source: source.id, row, col }] };
}

/** The one sheet a one-source workspace replays into. */
function only(doc: Document) {
  const [sheet] = doc.sheets!.values();
  return sheet!;
}

test("a .uno opens with its log applied, and saves back", async () => {
  const saved = read("sales-q3.csv", bytes);
  saved.set(0, UNITS, "1204");
  saved.apply(UNITS, parseProgram('replace(/,/, "")'));
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: "sales-q3",
        name: "sales-q3.csv",
        raw: bytes,
        rows: ROWS,
        cols: COLS,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: "sales-q3",
    log: saved.edits().map((edit) => ({ source: "sales-q3", edit })),
    extra: new Map(),
  });

  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: "q3.uno", blob: new Blob([new Uint8Array(uno)]) });
    expect(src.opened.name).toBe("sales-q3.csv");
    expect(src.opened.edits).toHaveLength(2);
    expect(src.opened.columns[UNITS]).toMatchObject({ kind: "num", flagged: false });
    expect((await src.rows(5, 1)).rows[0]![UNITS]).toBe("1101");

    engine.mode(true);
    await src.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const back = readDocument("q3.uno", await engine.save(at(src, 1, UNITS), ROOMY));

    expect(back.log).toHaveLength(3);
    expect(back.sources[0]!.raw).toEqual(bytes);
    expect(back.sources[0]!.state.active).toEqual({ row: 1, col: UNITS });
    expect(only(back).raw(1, UNITS)).toBe("986");
    expect(only(back).raw(5, UNITS)).toBe("1101");
  } finally {
    done();
  }
});

test("a save refuses a source over its limit, by name", async () => {
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    await expect(engine.save(at(src, 0, 0), CRAMPED)).rejects.toThrow(
      /^sales-q3\.csv is .* until it can point at the file instead$/,
    );

    const back = readDocument("sales-q3.uno", await engine.save(at(src, 0, 0), ROOMY));
    expect(back.sources[0]!.raw).toEqual(bytes);
    expect(back.manifest.sources[0]!.rows).toBe(ROWS);
  } finally {
    done();
  }
});

// The work the CPA plan starts from: several exports in one workspace, each
// fixed where it is, saved as one file and opened again whole.
test("sources added to one workspace save and reopen together", async () => {
  const first = connect();
  let uno: Uint8Array;
  try {
    const { engine } = first;
    const sales = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    const ads = await openOne(engine, { name: "Google Ads.csv", blob: new Blob([ADS]) });
    expect([sales.id, ads.id]).toEqual(["sales-q3", "google-ads"]);
    expect(ads.opened.columns.map((c) => c.header)).toEqual(["Ad_Date", "Cost"]);
    await indexed(sales);

    // Edits in turn across the two, the way a person moves between tabs.
    engine.mode(true);
    await sales.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    await ads.edit({ op: Op.Set, row: 0, col: COST, now: "12.50" });
    await sales.edit({ op: Op.Set, row: 2, col: UNITS, now: "1455" });
    expect((await ads.rows(0, ADS_ROWS)).rows.map((r) => r[COST])).toEqual([
      "12.50",
      "$8.00",
      "$3.10",
    ]);

    // Undo takes back the tab's own last edit, not the workspace's.
    const undone = await ads.undo();
    expect(undone.edit).toMatchObject({ op: "set", row: 0, col: COST });
    await ads.redo();

    uno = await engine.save(
      {
        source: ads.id,
        cells: [
          { source: sales.id, row: 2, col: UNITS },
          { source: ads.id, row: 0, col: COST },
        ],
      },
      ROOMY,
    );
  } finally {
    first.done();
  }

  const back = readDocument("q4.uno", uno);
  expect(back.sources.map((s) => s.name)).toEqual(["sales-q3.csv", "Google Ads.csv"]);
  expect(back.active).toBe("google-ads");
  expect(back.sources[1]!.state.active).toEqual({ row: 0, col: COST });
  expect(back.sheets!.get("sales-q3")!.raw(2, UNITS)).toBe("1455");
  expect(back.sheets!.get("google-ads")!.raw(0, COST)).toBe("12.50");

  // The redo went on the end of the log, which is when it was made.
  const lines = strFromU8(unzipSync(uno)[LOG_ENTRY]!).trim().split("\n");
  expect(lines.map((l) => (JSON.parse(l) as { source: string }).source)).toEqual([
    "sales-q3",
    "sales-q3",
    "google-ads",
  ]);

  // And the engine opens it again as the same two sources.
  const second = connect();
  try {
    const { sources, showing } = await second.engine.open({
      name: "q4.uno",
      blob: new Blob([new Uint8Array(uno)]),
    });
    expect(sources.map((s) => s.id)).toEqual(["sales-q3", "google-ads"]);
    expect(showing).toBe("google-ads");
    expect(sources[1]!.opened.edits).toHaveLength(1);
    expect((await sources[0]!.rows(2, 1)).rows[0]![UNITS]).toBe("1455");
  } finally {
    second.done();
  }
});

test("a file added twice is two sources, told apart by id", async () => {
  const { engine, done } = connect();
  try {
    const a = await openOne(engine, { name: "export.csv", blob: new Blob([ADS]) });
    const b = await openOne(engine, { name: "export.csv", blob: new Blob([ADS]) });
    expect([a.id, b.id]).toEqual(["export", "export_2"]);
  } finally {
    done();
  }
});

test("removing a source takes its edits out of the log, and keeps the last one", async () => {
  const { engine, done } = connect();
  try {
    const sales = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    const ads = await openOne(engine, { name: "ads.csv", blob: new Blob([ADS]) });
    engine.mode(true);
    await ads.edit({ op: Op.Set, row: 0, col: COST, now: "12.50" });
    await sales.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });

    await engine.remove(ads);
    await expect(ads.rows(0, 1)).rejects.toThrow("no source called ads is open");
    await expect(engine.remove(sales)).rejects.toThrow(
      "sales-q3.csv is the only source here, and a workspace needs one",
    );

    const back = readDocument("q3.uno", await engine.save(at(sales, 0, 0), ROOMY));
    expect(back.sources.map((s) => s.id)).toEqual(["sales-q3"]);
    expect(back.log.map((l) => l.source)).toEqual(["sales-q3"]);
  } finally {
    done();
  }
});

test("sources over the limit together are refused, counted", async () => {
  const { engine, done } = connect();
  try {
    const sales = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await openOne(engine, { name: "again.csv", blob: new Blob([bytes]) });
    await expect(engine.save(at(sales, 0, 0), bytes.length + 1)).rejects.toThrow(
      /^the 2 sources come to .* until it can point at the file instead$/,
    );
  } finally {
    done();
  }
});

test("a .uno opens only into an empty workspace", async () => {
  const { engine, done } = connect();
  try {
    const sales = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    const uno = await engine.save(at(sales, 0, 0), ROOMY);
    await expect(
      engine.open({ name: "q3.uno", blob: new Blob([new Uint8Array(uno)]) }),
    ).rejects.toThrow("q3.uno is a workspace of its own");
  } finally {
    done();
  }
});
