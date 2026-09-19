import { strFromU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";

import {
  BASE_VERSION,
  FORMAT_VERSION,
  FORMULA_VERSION,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  STATE_ENTRY,
  newManifest,
  readDocument,
  sourceId,
  writeDocument,
} from "../../src/document/index.ts";
import type { Document, State } from "../../src/document/index.ts";
import { parse as parseFormula } from "../../src/formula/index.ts";
import { read as ingestRead } from "../../src/ingest/index.ts";
import { parse as parseProgram } from "../../src/program/index.ts";
import type { Sheet } from "../../src/sheet/index.ts";

const CSV_BODY =
  'date,region,units\n2026-07-01,West,"1,204"\n2026-07-01,East,987\n2026-07-02,North,"1,455"\n';
const ROWS = 3;
const COLS = 3;
const REGION = 1;
const UNITS = 2;

/** The cell a saved workspace was left on. */
const ACTIVE = { row: 2, col: REGION };

const encoder = new TextEncoder();

/** A workspace of one source, built the way the app builds one: ingest the
 * bytes, edit the sheet, then hand the writer what it cannot see for itself. */
function saved(name: string, edit?: (s: Sheet) => void): { bytes: Uint8Array; doc: Document } {
  const doc = oneSource(name, ingestRead(name, CSV_BODY), edit);
  return { bytes: writeDocument(doc), doc };
}

function oneSource(
  name: string,
  sh: Sheet,
  edit?: (s: Sheet) => void,
  state: State = { active: ACTIVE },
): Document {
  edit?.(sh);
  const id = sourceId(name, []);
  return {
    manifest: newManifest(),
    sources: [{ id, name, raw: encoder.encode(CSV_BODY), rows: sh.rows(), cols: sh.cols(), state }],
    active: id,
    log: sh.edits().map((edit) => ({ source: id, edit })),
    extra: new Map(),
  };
}

/** The one sheet a one-source workspace replays into. */
function only(doc: Document): Sheet {
  const [sheet] = doc.sheets!.values();
  return sheet!;
}

test("a round trip rebuilds the workspace", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
  });

  const back = readDocument("sales.csv", bytes);

  expect(only(back).rows()).toBe(ROWS);
  expect(only(back).cols()).toBe(COLS);
  expect(only(back).raw(0, UNITS), "the edit was not replayed").toBe("1204");
  expect(back.sources[0]!.state.active).toEqual(ACTIVE);
  expect(back.sources[0]!.raw, "the source went in byte for byte").toEqual(doc.sources[0]!.raw);
  expect(only(back).logEquals(doc.log.map((l) => l.edit))).toBe(true);
});

test("the container holds four named entries", () => {
  const { bytes, doc } = saved("sales.tsv");
  const entries = Object.keys(unzipSync(bytes)).sort();

  expect(entries).toEqual(
    [MANIFEST_ENTRY, doc.manifest.sources[0]!.entry, STATE_ENTRY, LOG_ENTRY].sort(),
  );
  // The source entry is named after the file it holds, so `unzip -l` on a
  // workspace opened from a TSV does not call its bytes source.csv.
  expect(doc.manifest.sources[0]!.entry).toBe("data/source.tsv");
});

// Everything the file says about itself is taken from what is actually written,
// so no code path can produce a manifest describing a different file.
test("the manifest is measured from the bytes", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
  });

  const m = doc.manifest;
  expect(m.generator).toBe("uno 0.2.0");
  expect(m.sources[0]!.bytes).toBe(encoder.encode(CSV_BODY).length);
  expect(m.sources[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(m.edits.count).toBe(1);
  expect(m.sources[0]!.rows).toBe(ROWS);
  expect(m.sources[0]!.cols).toBe(COLS);

  // And the file agrees with the value handed back.
  const written = JSON.parse(strFromU8(unzipSync(bytes)[MANIFEST_ENTRY]!)) as Record<
    string,
    unknown
  >;
  expect((written["source"] as Record<string, unknown>)["sha256"]).toBe(m.sources[0]!.sha256);
});

test("a second save keeps the created time", () => {
  const { doc } = saved("sales.csv");
  const created = doc.manifest.created;
  expect(created).toBeDefined();

  writeDocument(doc);
  expect(doc.manifest.created).toEqual(created);
});

// A reader that guesses at a layout it does not know will either crash or
// silently drop what it could not read and save that loss back over the file.
test("a newer format is refused by name", () => {
  const { bytes } = saved("sales.csv");
  const entries = unzipSync(bytes);

  const m = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as Record<string, unknown>;
  m["format"] = FORMAT_VERSION + 1;
  entries[MANIFEST_ENTRY] = encoder.encode(JSON.stringify(m));

  let thrown: Error | undefined;
  try {
    readDocument("sales.csv", zipSync(entries));
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown).toBeDefined();
  expect(thrown!.message).toContain("sales.csv");
  expect(thrown!.message).toContain("newer uno");
});

// Version skew is only survivable if an older uno hands back the entries it
// could not read.
test("an unknown entry survives a round trip", () => {
  const { bytes } = saved("sales.csv");
  const entries = unzipSync(bytes);
  entries["future/thing.json"] = encoder.encode('{"kept":true}');

  const back = readDocument("sales.csv", zipSync(entries));
  expect(back.extra.get("future/thing.json")).toBeDefined();

  const again = unzipSync(writeDocument(back));
  expect(strFromU8(again["future/thing.json"]!)).toBe('{"kept":true}');
});

// A log cut short still replays up to its last complete line. That tolerance is
// the whole argument for JSONL over JSON.
test("a truncated log replays its complete lines", () => {
  const { bytes } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
    s.set(2, UNITS, "1455");
  });

  const entries = unzipSync(bytes);
  const log = strFromU8(entries[LOG_ENTRY]!);
  const cut = log.indexOf("\n") + 1;
  const torn = 12; // bytes of the second line that made it out
  entries[LOG_ENTRY] = encoder.encode(log.slice(0, cut) + log.slice(cut, cut + torn));

  const back = readDocument("sales.csv", zipSync(entries));
  expect(back.log, "the complete line should survive").toHaveLength(1);
  expect(only(back).raw(0, UNITS)).toBe("1204");
});

// Damage in the middle is a different thing: stopping there would silently
// discard the operations after it.
test("a log damaged in the middle fails the open", () => {
  const { bytes } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
    s.set(2, UNITS, "1455");
  });

  const entries = unzipSync(bytes);
  const lines = strFromU8(entries[LOG_ENTRY]!).split("\n");
  entries[LOG_ENTRY] = encoder.encode(["{not json", lines[1]!, ""].join("\n"));

  expect(() => readDocument("sales.csv", zipSync(entries))).toThrow();
});

test("a file that is not a zip is refused by name", () => {
  let thrown: Error | undefined;
  try {
    readDocument("sales.uno", encoder.encode("this is not a zip"));
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown).toBeDefined();
  expect(thrown!.message).toContain("sales.uno");
});

// An operation an older uno does not know cannot be discovered halfway through
// a replay, so the file declares the oldest build that can read it.
describe("the format version follows the log", () => {
  test("plain edits stay at 1", () => {
    const { doc } = saved("sales.csv", (s) => {
      s.set(0, UNITS, "1204");
    });
    expect(doc.manifest.format).toBe(BASE_VERSION);
  });

  test("a column rule needs 2", () => {
    const { doc } = saved("sales.csv", (s) => {
      s.apply(UNITS, parseProgram('replace(/,/, "")'));
    });
    expect(doc.manifest.format).toBe(RULE_VERSION);
  });

  test("a binding needs 3", () => {
    const { doc } = saved("sales.csv", (s) => {
      s.bind(REGION, parseFormula("units * 2"));
    });
    expect(doc.manifest.format).toBe(FORMULA_VERSION);
  });
});

// A column op is one line for a whole column, and replay has to produce the
// same column it did the first time.
test("a column op round-trips", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.apply(UNITS, parseProgram('replace(/,/, "")'));
  });
  expect(doc.log).toHaveLength(1);

  const back = readDocument("sales.csv", bytes);
  expect(only(back).raw(0, UNITS)).toBe("1204");
  expect(only(back).raw(2, UNITS)).toBe("1455");
  expect(only(back).columns[UNITS]!.kind).toBe("num");
});

// The expression is what the file carries, not the results, so reopening
// recomputes them rather than reading them back.
test("a binding round-trips and recomputes", () => {
  const { bytes } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
    s.bind(REGION, parseFormula("units * 2"));
  });

  const back = readDocument("sales.csv", bytes);
  expect(only(back).display(0, REGION)).toBe("2408");
  expect(only(back).binding(REGION)).toBe("units * 2");
  // Binding never removed the column's own values -- it stopped them being what
  // display hands out -- so they are still underneath, waiting for an unbind.
  expect(only(back).raw(0, REGION)).toBe("West");
});

// The library reference is a convenience about this machine. The expression is
// in the log, so a file computes for someone who has never seen the sender's
// library.
test("a bound file computes with no library to resolve", () => {
  const { bytes } = saved("sales.csv", (s) => {
    s.bind(REGION, parseFormula("units * 2"));
  });

  const entries = unzipSync(bytes);
  const state = JSON.parse(strFromU8(entries[STATE_ENTRY]!)) as Record<string, unknown>;
  expect(state["columnFormulas"], "no bound reference was written").toBeUndefined();

  const back = readDocument("sales.csv", bytes);
  expect(only(back).display(1, REGION)).toBe("1974");
});

test("a library reference round-trips when there is one", () => {
  const sh = ingestRead("sales.csv", CSV_BODY);
  sh.bind(REGION, parseFormula("units * 2"));

  const doc = oneSource("sales.csv", sh, undefined, {
    active: { row: 0, col: 0 },
    columnFormulas: [{ col: REGION, ref: "double-units" }],
  });

  const back = readDocument("sales.csv", writeDocument(doc));
  expect(back.sources[0]!.state.columnFormulas).toEqual([{ col: REGION, ref: "double-units" }]);
});

// ------------------------------------------------------------ many sources

/** A second export, of a different shape, for a workspace of two. */
const ADS_BODY = "Ad_Date\tCost\n2024-11-16\t$12.50\n20-11-2024\t$8.00\n";
const ADS_ROWS = 2;
const COST = 1;

/**
 * A workspace of two sources, edited in turn the way a person moves between
 * tabs: a sales cell, then an ads cell, then a sales cell again.
 */
function twoSources(): { bytes: Uint8Array; doc: Document } {
  const sales = ingestRead("sales.csv", CSV_BODY);
  const ads = ingestRead("Google Ads.tsv", ADS_BODY);
  const log: Document["log"] = [];
  const logged = (source: string, sh: Sheet): void => {
    log.push({ source, edit: sh.edits()[sh.edits().length - 1]! });
  };

  sales.set(0, UNITS, "1204");
  logged("sales", sales);
  ads.set(0, COST, "12.50");
  logged("google-ads", ads);
  sales.set(2, UNITS, "1455");
  logged("sales", sales);

  const doc: Document = {
    manifest: newManifest(),
    sources: [
      {
        id: "sales",
        name: "sales.csv",
        raw: encoder.encode(CSV_BODY),
        rows: sales.rows(),
        cols: sales.cols(),
        state: { active: ACTIVE },
      },
      {
        id: "google-ads",
        name: "Google Ads.tsv",
        raw: encoder.encode(ADS_BODY),
        rows: ads.rows(),
        cols: ads.cols(),
        state: { active: { row: 1, col: COST } },
      },
    ],
    active: "google-ads",
    log,
    extra: new Map(),
  };
  return { bytes: writeDocument(doc), doc };
}

describe("a workspace of several sources", () => {
  test("round-trips every source with its own edits", () => {
    const { bytes } = twoSources();
    const back = readDocument("q4.uno", bytes);

    expect(back.sources.map((s) => s.id)).toEqual(["sales", "google-ads"]);
    expect(back.active).toBe("google-ads");

    const sales = back.sheets!.get("sales")!;
    expect(sales.rows()).toBe(ROWS);
    expect(sales.raw(0, UNITS)).toBe("1204");
    expect(sales.raw(2, UNITS)).toBe("1455");

    const ads = back.sheets!.get("google-ads")!;
    expect(ads.rows()).toBe(ADS_ROWS);
    expect(ads.raw(0, COST)).toBe("12.50");
    expect(ads.raw(1, COST), "an edit to sales did not land in ads").toBe("$8.00");

    expect(back.sources[1]!.raw, "the source went in byte for byte").toEqual(
      encoder.encode(ADS_BODY),
    );
    expect(back.sources[0]!.state.active).toEqual(ACTIVE);
    expect(back.sources[1]!.state.active).toEqual({ row: 1, col: COST });
  });

  test("needs format 4, and gives each source an entry of its own", () => {
    const { bytes, doc } = twoSources();
    expect(doc.manifest.format).toBe(FORMAT_VERSION);

    const entries = Object.keys(unzipSync(bytes)).sort();
    expect(entries).toEqual(
      [
        MANIFEST_ENTRY,
        "data/source/sales.csv",
        "data/source/google-ads.tsv",
        STATE_ENTRY,
        LOG_ENTRY,
      ].sort(),
    );

    const m = JSON.parse(strFromU8(unzipSync(bytes)[MANIFEST_ENTRY]!)) as Record<string, unknown>;
    expect(m["source"], "the one-source key is not written").toBeUndefined();
    expect((m["sources"] as Array<Record<string, unknown>>).map((s) => s["name"])).toEqual([
      "sales.csv",
      "Google Ads.tsv",
    ]);
  });

  // The order edits were made in, across sources, is what a person reads back.
  test("the log keeps the order the edits were made in, and names each source", () => {
    const { bytes } = twoSources();
    const lines = strFromU8(unzipSync(bytes)[LOG_ENTRY]!)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines.map((l) => [l["source"], l["seq"]])).toEqual([
      ["sales", 1],
      ["google-ads", 1],
      ["sales", 2],
    ]);
    expect(readDocument("q4.uno", bytes).log.map((l) => l.source)).toEqual([
      "sales",
      "google-ads",
      "sales",
    ]);
  });

  test("a line naming a source the file does not hold is refused by name", () => {
    const entries = unzipSync(twoSources().bytes);
    const log = strFromU8(entries[LOG_ENTRY]!).replace('"google-ads"', '"tiktok"');
    entries[LOG_ENTRY] = encoder.encode(log);

    expect(() => readDocument("q4.uno", zipSync(entries))).toThrow(
      /q4\.uno: .* changes tiktok, which is not a source in this file/,
    );
  });

  // A file every earlier build wrote gains a second source without its first
  // one being renamed.
  test("a one-source file takes a second source and keeps its first one's id", () => {
    const { bytes } = saved("sales.csv", (s) => s.set(0, UNITS, "1204"));
    const back = readDocument("sales.uno", bytes);
    expect(back.sources.map((s) => s.id)).toEqual(["sales"]);

    const ads = ingestRead("ads.tsv", ADS_BODY);
    back.sources.push({
      id: sourceId(
        "ads.tsv",
        back.sources.map((s) => s.id),
      ),
      name: "ads.tsv",
      raw: encoder.encode(ADS_BODY),
      rows: ads.rows(),
      cols: ads.cols(),
      state: { active: { row: 0, col: 0 } },
    });

    const again = readDocument("sales.uno", writeDocument(back));
    expect(again.manifest.format).toBe(FORMAT_VERSION);
    expect(again.sources.map((s) => s.id)).toEqual(["sales", "ads"]);
    expect(again.sheets!.get("sales")!.raw(0, UNITS)).toBe("1204");
    expect(again.log.map((l) => l.source)).toEqual(["sales"]);
  });

  test("a log naming a source that is not there is not written", () => {
    const { doc } = twoSources();
    doc.log.push({ source: "tiktok", edit: doc.log[0]!.edit });
    expect(() => writeDocument(doc)).toThrow("names tiktok, which is not a source here");
  });
});

describe("a source's id", () => {
  test("is its file's name, without the extension", () => {
    expect(sourceId("sales-q3.csv", [])).toBe("sales-q3");
    expect(sourceId("/home/cpa/exports/Google Ads.csv", [])).toBe("google-ads");
    expect(sourceId("C:\\exports\\TikTok Shop (2025).tsv", [])).toBe("tiktok-shop-2025");
  });

  test("is told apart from a taken one the way a repeated column is", () => {
    expect(sourceId("export.csv", ["export"])).toBe("export_2");
    expect(sourceId("export.csv", ["export", "export_2"])).toBe("export_3");
  });

  test("is never empty", () => {
    expect(sourceId("", [])).toBe("source");
    expect(sourceId("¿?.csv", [])).toBe("source");
  });
});
