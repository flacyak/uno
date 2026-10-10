// The engine and a .uno: opening one with its log applied, saving back, and a
// workspace of several sources. A save points at sources with a path and
// carries the rest, so most tests are about paths: how they are written,
// what happens when one stops resolving, and relinking.

import { strFromU8, unzipSync, zipSync } from "fflate";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vite-plus/test";

import {
  LOG_ENTRY,
  MANIFEST_ENTRY,
  POINTED_VERSION,
  STATE_ENTRY,
  newManifest,
  readContainer,
  readDocument,
  writeDocument,
} from "../../src/document/index.ts";
import type { Document, Source } from "../../src/document/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { sha256Hex } from "../../src/go/index.ts";
import { read } from "../../src/ingest/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { COLS, ROWS, UNITS } from "../testdata/sales-q3.ts";
import { FIXTURE, bytes, connect, indexed, openOne, saidIn } from "./harness.ts";

/** A carry limit the 240 KB fixture fits under, and one it overflows. */
const ROOMY = 1 << 20;
const CRAMPED = 1 << 10;

/** A second, small export of another shape. */
const ADS = "Ad_Date,Cost\n2024-11-16,$12.50\n20-11-2024,$8.00\n2024/11/16,$3.10\n";
const ADS_ROWS = 3;
const COST = 1;

/** A save place showing `source` at `row`, `col`, with the .uno at `uno`. */
function at(source: SourceHandle, row: number, col: number, uno = "") {
  return { source: source.id, cells: [{ source: source.id, row, col }], at: uno };
}

/** The one sheet a one-source workspace replays into. */
function only(doc: Document) {
  const [sheet] = doc.sheets!.values();
  return sheet!;
}

/** The manifest's sources. */
function listed(uno: Uint8Array): Source[] {
  return readContainer("test.uno", uno).manifest.sources;
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uno-save-"));
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
    at: "",
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
    expect(back.sources[0]!.raw, "bytes with no file behind them stay carried").toEqual(bytes);
    expect(back.sources[0]!.state.active).toEqual({ row: 1, col: UNITS });
    expect(only(back).raw(1, UNITS)).toBe("986");
    expect(only(back).raw(5, UNITS)).toBe("1101");
  } finally {
    done();
  }
});

test("a source opened from a path is pointed at, not copied", async () => {
  const { engine, done } = connect();
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    await indexed(src);
    const uno = await engine.save(at(src, 0, 0), CRAMPED);

    // Under a limit far smaller than the source.
    expect(uno.length).toBeLessThan(CRAMPED);
    const [s] = listed(uno);
    expect(s!.path).toBe(FIXTURE);
    expect(s!.entry, "nothing was copied in").toBe("");
    expect(s!.sha256, "and nothing was hashed to say so").toBe("");
    expect(s!.bytes).toBe(bytes.length);
    expect(s!.rows).toBe(ROWS);
    expect(Object.keys(unzipSync(uno)).sort()).toEqual(
      [MANIFEST_ENTRY, STATE_ENTRY, LOG_ENTRY].sort(),
    );

    const back = readContainer("sales-q3.uno", uno);
    expect(back.manifest.format).toBe(POINTED_VERSION);
    expect(back.sources[0]!.raw).toBeUndefined();
  } finally {
    done();
  }
});

test("a source beside the workspace is pointed at relative to it, and survives the move", async () => {
  const here = await scratch();
  const there = await scratch();
  await copyFile(FIXTURE, join(here, "sales-q3.csv"));

  const first = connect();
  let uno: Uint8Array;
  try {
    const src = await openOne(first.engine, {
      name: "sales-q3.csv",
      path: join(here, "sales-q3.csv"),
    });
    first.engine.mode(true);
    await src.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    uno = await first.engine.save(at(src, 0, UNITS, join(here, "q3.uno")), ROOMY);
  } finally {
    first.done();
  }
  expect(listed(uno)[0]!.path).toBe("sales-q3.csv");

  // Both files moved to another folder and opened from there.
  await writeFile(join(there, "q3.uno"), uno);
  await copyFile(FIXTURE, join(there, "sales-q3.csv"));
  await rm(here, { recursive: true, force: true });

  const second = connect();
  try {
    const src = await openOne(second.engine, { name: "q3.uno", path: join(there, "q3.uno") });
    expect(src.opened.link).toEqual({ path: join(there, "sales-q3.csv") });
    expect(src.opened.edits).toHaveLength(1);
    expect((await src.rows(0, 1)).rows[0]![UNITS]).toBe("1204");
  } finally {
    second.done();
  }
});

test("a source whose file has gone opens as itself, without its rows", async () => {
  const dir = await scratch();
  const csv = join(dir, "ads.csv");
  await writeFile(csv, ADS);

  const first = connect();
  let uno: Uint8Array;
  try {
    const sales = await openOne(first.engine, { name: "sales-q3.csv", path: FIXTURE });
    const ads = await openOne(first.engine, { name: "ads.csv", path: csv });
    first.engine.mode(true);
    await ads.edit({ op: Op.Set, row: 0, col: COST, now: "12.50" });
    uno = await first.engine.save(
      {
        source: sales.id,
        cells: [{ source: ads.id, row: 0, col: COST }],
        at: join(dir, "q3.uno"),
      },
      ROOMY,
    );
  } finally {
    first.done();
  }
  await writeFile(join(dir, "q3.uno"), uno);
  await rm(csv);

  const second = connect();
  try {
    const { sources } = await second.engine.open({ name: "q3.uno", path: join(dir, "q3.uno") });
    const ads = sources.find((s) => s.id === "ads")!;

    expect(
      sources.map((s) => s.id),
      "the workspace opened anyway",
    ).toEqual(["sales-q3", "ads"]);
    expect(ads.opened.link?.path).toBe(csv);
    expect(saidIn(ads.opened.link?.missing)).toContain("ads.csv");
    expect(ads.opened.edits, "the edit made through it is still here").toHaveLength(1);
    await expect(ads.rows(0, 1)).rejects.toThrow("point it at one to read its rows");

    // A save keeps the missing source and its log.
    const again = await second.engine.save(
      { source: "sales-q3", cells: [], at: join(dir, "q3.uno") },
      ROOMY,
    );
    const back = readContainer("q3.uno", again);
    expect(back.sources.map((s) => s.id)).toEqual(["sales-q3", "ads"]);
    expect(back.log.filter((l) => l.source === "ads")).toHaveLength(1);
  } finally {
    second.done();
  }
});

test("pointing a source at a file again replays its edits over it", async () => {
  const dir = await scratch();
  const was = join(dir, "ads.csv");
  await writeFile(was, ADS);

  const first = connect();
  let uno: Uint8Array;
  try {
    const ads = await openOne(first.engine, { name: "ads.csv", path: was });
    first.engine.mode(true);
    await ads.edit({ op: Op.Set, row: 0, col: COST, now: "12.50" });
    uno = await first.engine.save(at(ads, 0, COST, join(dir, "ads.uno")), ROOMY);
  } finally {
    first.done();
  }
  await writeFile(join(dir, "ads.uno"), uno);

  // The same file under another name, with the original removed.
  await writeFile(join(dir, "elsewhere.csv"), ADS);
  await rm(was);

  const second = connect();
  try {
    const gone = await openOne(second.engine, { name: "ads.uno", path: join(dir, "ads.uno") });
    expect(gone.opened.link?.missing).toBeDefined();

    // A relink to a file too short for the log to replay on is refused.
    await writeFile(join(dir, "short.csv"), "Ad_Date,Cost\n");
    await expect(
      second.engine.relink(gone, { name: "short.csv", path: join(dir, "short.csv") }),
    ).rejects.toThrow(/replaying edits to short\.csv/);

    const back = await second.engine.relink(gone, {
      name: "ads.csv",
      path: join(dir, "elsewhere.csv"),
    });
    expect(back.id, "the id the log names is the one it keeps").toBe("ads");
    expect(back.opened.link).toEqual({ path: join(dir, "elsewhere.csv") });
    expect(back.opened.edits).toHaveLength(1);
    expect((await back.rows(0, ADS_ROWS)).rows.map((r) => r[COST])).toEqual([
      "12.50",
      "$8.00",
      "$3.10",
    ]);

    // The save points at the new path.
    const again = await second.engine.save(at(back, 0, COST, join(dir, "ads.uno")), ROOMY);
    expect(listed(again)[0]!.path).toBe("elsewhere.csv");
  } finally {
    second.done();
  }
});

test("a source whose file changed size opens and says so", async () => {
  const dir = await scratch();
  const csv = join(dir, "ads.csv");
  await writeFile(csv, ADS);

  const first = connect();
  let uno: Uint8Array;
  try {
    const ads = await openOne(first.engine, { name: "ads.csv", path: csv });
    uno = await first.engine.save(at(ads, 0, 0, join(dir, "ads.uno")), ROOMY);
  } finally {
    first.done();
  }
  await writeFile(join(dir, "ads.uno"), uno);
  await writeFile(csv, ADS + "2024-11-17,$4.20\n");

  const second = connect();
  try {
    const ads = await openOne(second.engine, { name: "ads.uno", path: join(dir, "ads.uno") });
    expect(ads.opened.link?.missing).toBeUndefined();
    expect(saidIn(ads.opened.link?.changed)).toContain("when the workspace was saved");
    expect((await ads.rows(0, 4)).rows).toHaveLength(4);
  } finally {
    second.done();
  }
});

test("sources added to one workspace save and reopen together", async () => {
  const dir = await scratch();
  const adsPath = join(dir, "Google Ads.csv");
  await writeFile(adsPath, ADS);

  const first = connect();
  let uno: Uint8Array;
  try {
    const { engine } = first;
    const sales = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    const ads = await openOne(engine, { name: "Google Ads.csv", path: adsPath });
    expect([sales.id, ads.id]).toEqual(["sales-q3", "google-ads"]);
    expect(ads.opened.columns.map((c) => c.header)).toEqual(["Ad_Date", "Cost"]);
    await indexed(sales);

    // Edits alternate between the two sources.
    engine.mode(true);
    await sales.edit({ op: Op.Set, row: 0, col: UNITS, now: "1204" });
    await ads.edit({ op: Op.Set, row: 0, col: COST, now: "12.50" });
    await sales.edit({ op: Op.Set, row: 2, col: UNITS, now: "1455" });
    expect((await ads.rows(0, ADS_ROWS)).rows.map((r) => r[COST])).toEqual([
      "12.50",
      "$8.00",
      "$3.10",
    ]);

    // Undo takes back the source's own last edit.
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
        at: join(dir, "q4.uno"),
      },
      ROOMY,
    );
  } finally {
    first.done();
  }

  await writeFile(join(dir, "q4.uno"), uno);

  const back = readContainer("q4.uno", uno);
  expect(back.sources.map((s) => s.name)).toEqual(["sales-q3.csv", "Google Ads.csv"]);
  expect(back.active).toBe("google-ads");
  expect(back.sources[1]!.state.active).toEqual({ row: 0, col: COST });
  // One path is absolute. The one beside the .uno is relative.
  expect(back.manifest.sources.map((s) => s.path)).toEqual([FIXTURE, "Google Ads.csv"]);

  // The redone edit is at the end of the log.
  const lines = strFromU8(unzipSync(uno)[LOG_ENTRY]!).trim().split("\n");
  expect(lines.map((l) => (JSON.parse(l) as { source: string }).source)).toEqual([
    "sales-q3",
    "sales-q3",
    "google-ads",
  ]);

  // Reopened as the same two sources.
  const second = connect();
  try {
    const { sources, showing } = await second.engine.open({
      name: "q4.uno",
      path: join(dir, "q4.uno"),
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

test("sources with no file behind them are refused over the limit, counted", async () => {
  const { engine, done } = connect();
  try {
    const sales = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    await expect(engine.save(at(sales, 0, 0), CRAMPED)).rejects.toThrow(
      /^sales-q3\.csv is .* no file to point at$/,
    );

    await openOne(engine, { name: "again.csv", blob: new Blob([bytes]) });
    await expect(engine.save(at(sales, 0, 0), bytes.length + 1)).rejects.toThrow(
      /^the 2 sources with no file behind them come to /,
    );
  } finally {
    done();
  }
});

test("a carried source that will not open keeps its bytes through a save", async () => {
  const broken = new Uint8Array(); // an empty entry, which every decoder refuses
  const uno = writeDocument({
    manifest: newManifest(),
    sources: [
      {
        id: "ads",
        name: "ads.csv",
        raw: bytes,
        rows: ROWS,
        cols: COLS,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: "ads",
    log: [],
    extra: new Map(),
    at: "",
  });
  // Swap in the broken entry and update the manifest's size and hash to match.
  const entries = unzipSync(uno);
  entries["data/source.csv"] = broken;
  const manifest = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as {
    source: { bytes: number; sha256: string };
  };
  manifest.source.bytes = broken.length;
  manifest.source.sha256 = sha256Hex(broken);
  entries[MANIFEST_ENTRY] = new TextEncoder().encode(JSON.stringify(manifest));

  const { engine, done } = connect();
  try {
    const src = await openOne(engine, {
      name: "q3.uno",
      blob: new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>]),
    });
    expect(src.opened.link?.missing).toBeDefined();

    const back = readContainer("q3.uno", await engine.save(at(src, 0, 0), ROOMY));
    expect(back.sources[0]!.raw, "the bytes went back in as they were").toEqual(broken);
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

test("saving the workspace over one of its own files is refused", async () => {
  const dir = await scratch();
  const csv = join(dir, "ads.csv");
  await writeFile(csv, ADS);

  const { engine, done } = connect();
  try {
    const ads = await openOne(engine, { name: "ads.csv", path: csv });
    await expect(engine.save(at(ads, 0, 0, csv), ROOMY)).rejects.toThrow(
      `${csv} is where ads.csv is read from · saving the workspace there would write over it`,
    );
    // The same name in another folder is allowed.
    const other = await scratch();
    expect(listed(await engine.save(at(ads, 0, 0, join(other, "ads.csv")), ROOMY))).toHaveLength(1);
  } finally {
    done();
  }
});

// A .uno points at a source by an absolute path, so a save of a source opened
// by a relative path is refused.
test("a source opened by a path that is true from nowhere is not pointed at", async () => {
  const dir = await scratch();
  const here = relative(process.cwd(), FIXTURE);

  const { engine, done } = connect();
  try {
    const sales = await openOne(engine, { name: "sales-q3.csv", path: here });
    for (const uno of [join(dir, "q3.uno"), ""]) {
      await expect(engine.save(at(sales, 0, 0, uno), ROOMY)).rejects.toThrow(
        `sales-q3.csv was opened by ${here}, which is relative to nowhere a workspace can point from · open it by its full path`,
      );
    }
  } finally {
    done();
  }
});
