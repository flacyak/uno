import { strFromU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";

import {
  BASE_VERSION,
  FORMAT_VERSION,
  LOG_ENTRY,
  MANIFEST_ENTRY,
  RULE_VERSION,
  STATE_ENTRY,
  newManifest,
  readDocument,
  writeDocument,
} from "../../src/document/index.ts";
import type { Document } from "../../src/document/index.ts";
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

/** A workspace, built the way the app builds one: ingest the bytes, edit the
 * sheet, then hand the writer what it cannot see for itself. */
function saved(name: string, edit?: (s: Sheet) => void): { bytes: Uint8Array; doc: Document } {
  const sh = ingestRead(name, CSV_BODY);
  edit?.(sh);

  const doc: Document = {
    manifest: {
      ...newManifest(name),
      sheet: { rows: sh.rows(), cols: sh.cols(), entry: "" },
    },
    raw: encoder.encode(CSV_BODY),
    state: { active: ACTIVE },
    edits: sh.edits(),
    extra: new Map(),
  };

  return { bytes: writeDocument(doc), doc };
}

test("a round trip rebuilds the workspace", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
  });

  const back = readDocument("sales.csv", bytes);

  expect(back.sheet!.rows()).toBe(ROWS);
  expect(back.sheet!.cols()).toBe(COLS);
  expect(back.sheet!.raw(0, UNITS), "the edit was not replayed").toBe("1204");
  expect(back.state.active).toEqual(ACTIVE);
  expect(back.raw, "the source went in byte for byte").toEqual(doc.raw);
  expect(back.sheet!.logEquals(doc.edits)).toBe(true);
});

test("the container holds four named entries", () => {
  const { bytes, doc } = saved("sales.tsv");
  const entries = Object.keys(unzipSync(bytes)).sort();

  expect(entries).toEqual(
    [MANIFEST_ENTRY, doc.manifest.source.entry, STATE_ENTRY, LOG_ENTRY].sort(),
  );
  // The source entry is named after the file it holds, so `unzip -l` on a
  // workspace opened from a TSV does not call its bytes source.csv.
  expect(doc.manifest.source.entry).toBe("data/source.tsv");
});

// Everything the file says about itself is taken from what is actually written,
// so no code path can produce a manifest describing a different file.
test("the manifest is measured from the bytes", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
  });

  const m = doc.manifest;
  expect(m.generator).toBe("uno 0.2.0");
  expect(m.source.bytes).toBe(encoder.encode(CSV_BODY).length);
  expect(m.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(m.edits.count).toBe(1);
  expect(m.sheet.rows).toBe(ROWS);
  expect(m.sheet.cols).toBe(COLS);

  // And the file agrees with the value handed back.
  const written = JSON.parse(strFromU8(unzipSync(bytes)[MANIFEST_ENTRY]!)) as Record<
    string,
    unknown
  >;
  expect((written["source"] as Record<string, unknown>)["sha256"]).toBe(m.source.sha256);
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
  expect(back.edits, "the complete line should survive").toHaveLength(1);
  expect(back.sheet!.raw(0, UNITS)).toBe("1204");
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

  test("a binding needs the current version", () => {
    const { doc } = saved("sales.csv", (s) => {
      s.bind(REGION, parseFormula("units * 2"));
    });
    expect(doc.manifest.format).toBe(FORMAT_VERSION);
  });
});

// A column op is one line for a whole column, and replay has to produce the
// same column it did the first time.
test("a column op round-trips", () => {
  const { bytes, doc } = saved("sales.csv", (s) => {
    s.apply(UNITS, parseProgram('replace(/,/, "")'));
  });
  expect(doc.edits).toHaveLength(1);

  const back = readDocument("sales.csv", bytes);
  expect(back.sheet!.raw(0, UNITS)).toBe("1204");
  expect(back.sheet!.raw(2, UNITS)).toBe("1455");
  expect(back.sheet!.columns[UNITS]!.kind).toBe("num");
});

// The expression is what the file carries, not the results, so reopening
// recomputes them rather than reading them back.
test("a binding round-trips and recomputes", () => {
  const { bytes } = saved("sales.csv", (s) => {
    s.set(0, UNITS, "1204");
    s.bind(REGION, parseFormula("units * 2"));
  });

  const back = readDocument("sales.csv", bytes);
  expect(back.sheet!.display(0, REGION)).toBe("2408");
  expect(back.sheet!.binding(REGION)).toBe("units * 2");
  // Binding never removed the column's own values -- it stopped them being what
  // display hands out -- so they are still underneath, waiting for an unbind.
  expect(back.sheet!.raw(0, REGION)).toBe("West");
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
  expect(back.sheet!.display(1, REGION)).toBe("1974");
});

test("a library reference round-trips when there is one", () => {
  const sh = ingestRead("sales.csv", CSV_BODY);
  sh.bind(REGION, parseFormula("units * 2"));

  const doc: Document = {
    manifest: {
      ...newManifest("sales.csv"),
      sheet: { rows: sh.rows(), cols: sh.cols(), entry: "" },
    },
    raw: encoder.encode(CSV_BODY),
    state: { active: { row: 0, col: 0 }, columnFormulas: [{ col: REGION, ref: "double-units" }] },
    edits: sh.edits(),
    extra: new Map(),
  };

  const back = readDocument("sales.csv", writeDocument(doc));
  expect(back.state.columnFormulas).toEqual([{ col: REGION, ref: "double-units" }]);
});
