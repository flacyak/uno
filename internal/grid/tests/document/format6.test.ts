// Format 6 tests: a source made of several files read as one, with `parts`
// and `header` keys. A workspace whose sources are all single files is still
// written as format 5, byte for byte. Covers what is written, round trips,
// and the refusals for malformed part lists.

import { strFromU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";

import {
  FORMAT_VERSION,
  MANIFEST_ENTRY,
  PARTS_VERSION,
  POINTED_VERSION,
  newManifest,
  readContainer,
  readDocument,
  writeDocument,
} from "../../src/document/index.ts";
import type { Document, Held, HeldParts } from "../../src/document/index.ts";
import { sha256Hex } from "../../src/go/index.ts";

const encoder = new TextEncoder();

const CSV_BODY = "date,region,units\n2026-07-01,West,1204\n2026-07-01,East,987\n";
const CSV_BYTES = encoder.encode(CSV_BODY);
const CSV_ROWS = 2;
const CSV_COLS = 3;

/** Fixed created time, so the full manifest text can be compared. */
const CREATED = new Date("2026-09-30T12:00:00Z");

/** Workspace path, and the bucket folder the parts are in. */
const AT = "/home/cpa/q4/books.uno";
const BUCKET_DIR = "s3://acme-exports/shop/2025";

/** A source of three monthly order files in a bucket, read as one. */
function orders(): HeldParts {
  return {
    id: "shop-orders",
    name: "shop-orders",
    connection: "acme-exports",
    parts: [
      {
        name: "orders-2025-10.csv",
        path: `${BUCKET_DIR}/orders-2025-10.csv`,
        bytes: 2_040_109_871,
        version: '"9b2cf5"',
        skip: 0,
        unterminated: false,
      },
      {
        name: "orders-2025-11.csv",
        path: `${BUCKET_DIR}/orders-2025-11.csv`,
        bytes: 2_254_857_830,
        version: '"41aa0e"',
        skip: 118,
        unterminated: true,
      },
      {
        name: "orders-2025-12.csv",
        path: `${BUCKET_DIR}/orders-2025-12.csv`,
        bytes: 2_791_728_742,
        version: '"c07d19"',
        skip: 118,
        unterminated: false,
      },
    ],
    header: "first",
    rows: 61_204_418,
    cols: 11,
    state: { active: { row: 0, col: 0 } },
  };
}

/** One pointed-at file source and one carried file source. */
function files(): Held[] {
  return [
    {
      id: "ledger",
      name: "ledger.csv",
      path: "/home/cpa/q4/exports/ledger.csv",
      bytes: 3_300_000_000,
      version: '"77aa01"',
      connection: "acme-exports",
      rows: 41_000_000,
      cols: 8,
      state: { active: { row: 0, col: 0 } },
    },
    {
      id: "sales",
      name: "sales.csv",
      raw: CSV_BYTES,
      rows: CSV_ROWS,
      cols: CSV_COLS,
      state: { active: { row: 1, col: 2 } },
    },
  ];
}

function workspace(sources: Held[], at = AT): Document {
  return {
    manifest: { ...newManifest(), created: CREATED },
    sources,
    active: sources[0]!.id,
    log: [
      {
        source: sources[0]!.id,
        edit: { seq: 1, op: "set", row: 3, col: 1, was: "West", now: "west" },
      },
    ],
    extra: new Map(),
    at,
  };
}

/** The written uno.json as text. */
function manifestText(uno: Uint8Array): string {
  return strFromU8(unzipSync(uno)[MANIFEST_ENTRY]!);
}

interface WrittenManifest {
  format: number;
  modified: string;
  sources: Array<Record<string, unknown>>;
}

function manifestOf(uno: Uint8Array): WrittenManifest {
  return JSON.parse(manifestText(uno)) as WrittenManifest;
}

/** Writes `doc`, applies `change` to its manifest, and returns the new .uno bytes. */
function tampered(doc: Document, change: (m: WrittenManifest) => void): Uint8Array {
  const entries = unzipSync(writeDocument(doc));
  const m = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]!)) as WrittenManifest;
  change(m);
  entries[MANIFEST_ENTRY] = encoder.encode(JSON.stringify(m));
  return zipSync(entries);
}

/** The parts of the first source of a written manifest. */
function partsOf(m: WrittenManifest): Array<Record<string, unknown>> {
  return m.sources[0]!["parts"] as Array<Record<string, unknown>>;
}

describe("a workspace with no source of several files", () => {
  // The full manifest text is compared, so any moved or added key fails.
  test("still writes format 5, to the byte", () => {
    const uno = writeDocument(workspace(files()));
    const m = manifestOf(uno);
    expect(m.format).toBe(POINTED_VERSION);
    expect(manifestText(uno)).toBe(`{
  "format": 5,
  "generator": "uno 0.2.0",
  "created": "2026-09-30T12:00:00Z",
  "modified": "${m.modified}",
  "sources": [
    {
      "id": "ledger",
      "name": "ledger.csv",
      "connection": "acme-exports",
      "bytes": 3300000000,
      "path": "exports/ledger.csv",
      "version": "\\"77aa01\\"",
      "rows": 41000000,
      "cols": 8
    },
    {
      "id": "sales",
      "name": "sales.csv",
      "bytes": ${CSV_BYTES.length},
      "sha256": "${sha256Hex(CSV_BYTES)}",
      "entry": "data/source/sales.csv",
      "rows": 2,
      "cols": 3
    }
  ],
  "sheet": {
    "entry": "sheet/state.json"
  },
  "edits": {
    "count": 1,
    "entry": "edits/log.jsonl"
  }
}
`);
  });

  test("goes back to format 5 once the source of several files is taken out", () => {
    const doc = workspace([...files(), orders()]);
    writeDocument(doc);
    expect(doc.manifest.format).toBe(PARTS_VERSION);

    doc.sources = files();
    writeDocument(doc);
    expect(doc.manifest.format).toBe(POINTED_VERSION);
  });
});

describe("a source of several files", () => {
  test("needs format 6, which is the highest this build writes", () => {
    const doc = workspace([orders()]);
    writeDocument(doc);
    expect(doc.manifest.format).toBe(PARTS_VERSION);
    expect(PARTS_VERSION).toBe(FORMAT_VERSION);
  });

  // Each part is written with its path, bytes and version, plus skip when it
  // is above zero and unterminated when it is true.
  test("is written as its parts, in order, and whether they have a header row", () => {
    const uno = writeDocument(workspace([orders()]));
    const m = manifestOf(uno);
    expect(manifestText(uno)).toBe(`{
  "format": 6,
  "generator": "uno 0.2.0",
  "created": "2026-09-30T12:00:00Z",
  "modified": "${m.modified}",
  "sources": [
    {
      "id": "shop-orders",
      "name": "shop-orders",
      "connection": "acme-exports",
      "parts": [
        {
          "path": "s3://acme-exports/shop/2025/orders-2025-10.csv",
          "bytes": 2040109871,
          "version": "\\"9b2cf5\\""
        },
        {
          "path": "s3://acme-exports/shop/2025/orders-2025-11.csv",
          "bytes": 2254857830,
          "version": "\\"41aa0e\\"",
          "skip": 118,
          "unterminated": true
        },
        {
          "path": "s3://acme-exports/shop/2025/orders-2025-12.csv",
          "bytes": 2791728742,
          "version": "\\"c07d19\\"",
          "skip": 118
        }
      ],
      "header": "first",
      "rows": 61204418,
      "cols": 11
    }
  ],
  "sheet": {
    "entry": "sheet/state.json"
  },
  "edits": {
    "count": 1,
    "entry": "edits/log.jsonl"
  }
}
`);
  });

  test("copies nothing in: the container holds the manifest, the state and the log", () => {
    const uno = writeDocument(workspace([orders()]));
    expect(Object.keys(unzipSync(uno)).sort()).toEqual(
      ["edits/log.jsonl", "sheet/state.json", MANIFEST_ENTRY].sort(),
    );
  });

  test("reads back as it was held, with its log", () => {
    const doc = workspace([orders(), ...files()]);
    const back = readContainer("books.uno", writeDocument(doc), AT);
    expect(back.sources[0]).toEqual(doc.sources[0]);
    // The file sources read back as before.
    expect(back.sources.slice(1)).toMatchObject(doc.sources.slice(1));
    expect(back.log).toEqual(doc.log);
    expect(back.active).toBe("shop-orders");
  });

  test("beside file sources, leaves them written as format 5 writes them", () => {
    const alone = manifestOf(writeDocument(workspace(files())));
    const beside = manifestOf(writeDocument(workspace([...files(), orders()])));
    expect(beside.format).toBe(PARTS_VERSION);
    expect(beside.sources.slice(0, alone.sources.length)).toEqual(alone.sources);
  });

  test("with no header row says so, and reads back the same", () => {
    const doc = workspace([{ ...orders(), header: "none" }]);
    const uno = writeDocument(doc);
    expect(manifestOf(uno).sources[0]!["header"]).toBe("none");
    expect(readContainer("books.uno", uno, AT).sources[0]!.header).toBe("none");
  });

  // A part at the defaults (undefined version, skip 0, unterminated false)
  // is written as its path and bytes alone.
  test("writes only a path and a size for a part that is whole, ends in a newline and has no version", () => {
    const source = orders();
    source.connection = undefined;
    source.parts = source.parts.map((part) => ({
      ...part,
      path: `/data/shop/${part.name}`,
      version: undefined,
      skip: 0,
      unterminated: false,
    }));
    const uno = writeDocument(workspace([source]));
    const m = manifestOf(uno);
    expect(Object.keys(m.sources[0]!)).toEqual(["id", "name", "parts", "header", "rows", "cols"]);
    for (const part of partsOf(m)) expect(Object.keys(part)).toEqual(["path", "bytes"]);
    expect(readContainer("books.uno", uno, AT).sources[0]).toEqual(source);
  });

  // A part's name is written only when it differs from the last segment of
  // its path.
  test("keeps a part's name where it is not the last piece of its path", () => {
    const source = orders();
    source.parts[1] = { ...source.parts[1]!, name: "november.tsv" };
    const uno = writeDocument(workspace([source]));
    expect(partsOf(manifestOf(uno)).map((part) => part["name"])).toEqual([
      undefined,
      "november.tsv",
      undefined,
    ]);
    expect(Object.keys(partsOf(manifestOf(uno))[1]!)).toEqual([
      "name",
      "path",
      "bytes",
      "version",
      "skip",
      "unterminated",
    ]);
    const [back] = readContainer("books.uno", uno, AT).sources;
    expect(back!.parts!.map((part) => part.name)).toEqual([
      "orders-2025-10.csv",
      "november.tsv",
      "orders-2025-12.csv",
    ]);
  });

  // Part paths under the workspace folder are stored relative and resolved
  // against the folder on read.
  test("points at a part beside the workspace relative to it", () => {
    const source = orders();
    source.parts = source.parts.map((part) => ({
      ...part,
      path: `/home/cpa/q4/exports/${part.name}`,
    }));
    const uno = writeDocument(workspace([source]));
    expect(partsOf(manifestOf(uno)).map((part) => part["path"])).toEqual(
      source.parts.map((part) => `exports/${part.name}`),
    );
    const [back] = readContainer("books.uno", uno, "/media/stick/q4/books.uno").sources;
    expect(back!.parts!.map((part) => part.path)).toEqual(
      source.parts.map((part) => `/media/stick/q4/exports/${part.name}`),
    );
  });

  // readDocument builds sheets only for carried sources.
  test("gets no sheet from readDocument, which opens no file", () => {
    const back = readDocument("books.uno", writeDocument(workspace([orders(), ...files()])), AT);
    expect([...back.sheets!.keys()]).toEqual(["sales"]);
    expect(back.sources.map((s) => s.id)).toEqual(["shop-orders", "ledger", "sales"]);
  });
});

describe("a source of several files is not written", () => {
  test("with no parts", () => {
    expect(() => writeDocument(workspace([{ ...orders(), parts: [] }]))).toThrow(
      "shop-orders has no parts to point at",
    );
  });

  test("with a part there is no path to", () => {
    const source = orders();
    source.parts[1] = { ...source.parts[1]!, path: "" };
    expect(() => writeDocument(workspace([source]))).toThrow(
      "shop-orders: orders-2025-11.csv (part 2 of 3) has no path to point at",
    );
  });
});

// readContainer refuses a malformed parts list, naming the part and the
// problem.
describe("a source of several files is refused on reading", () => {
  const NOVEMBER =
    "books.uno: shop-orders: part 2 of 3 (s3://acme-exports/shop/2025/orders-2025-11.csv)";

  const refusals: Array<[what: string, change: (m: WrittenManifest) => void, message: string]> = [
    [
      "parts that are not a list",
      (m) => (m.sources[0]!["parts"] = "orders-2025-10.csv"),
      "books.uno: shop-orders: parts is not a list of files",
    ],
    [
      "an empty list of parts",
      (m) => (m.sources[0]!["parts"] = []),
      "books.uno: shop-orders has no parts · several files read as one need at least one",
    ],
    [
      "a part that is not a file",
      (m) => (partsOf(m)[1] = ["orders-2025-11.csv"] as unknown as Record<string, unknown>),
      "books.uno: shop-orders: part 2 of 3 is not a file with a path and bytes",
    ],
    [
      "a part with no path",
      (m) => delete partsOf(m)[1]!["path"],
      "books.uno: shop-orders: part 2 of 3 has no path",
    ],
    [
      "a part with an empty path",
      (m) => (partsOf(m)[2]!["path"] = ""),
      "books.uno: shop-orders: part 3 of 3 has no path",
    ],
    [
      "a part with no bytes",
      (m) => delete partsOf(m)[1]!["bytes"],
      `${NOVEMBER} does not say how many bytes it is`,
    ],
    [
      "a part whose bytes are not a count",
      (m) => (partsOf(m)[1]!["bytes"] = "2254857830"),
      `${NOVEMBER} does not say how many bytes it is`,
    ],
    [
      "a part of fewer than no bytes",
      (m) => (partsOf(m)[1]!["bytes"] = -1),
      `${NOVEMBER} does not say how many bytes it is`,
    ],
    [
      "a part whose name is not text",
      (m) => (partsOf(m)[1]!["name"] = 11),
      `${NOVEMBER}: name is not text`,
    ],
    [
      "a part whose version is not text",
      (m) => (partsOf(m)[1]!["version"] = 41),
      `${NOVEMBER}: version is not text`,
    ],
    [
      "a part whose skip is not a count of bytes",
      (m) => (partsOf(m)[1]!["skip"] = 1.5),
      `${NOVEMBER}: skip is not a number of bytes`,
    ],
    [
      "a part whose unterminated is not a yes or a no",
      (m) => (partsOf(m)[1]!["unterminated"] = "yes"),
      `${NOVEMBER}: unterminated is neither true nor false`,
    ],
    [
      "no header mode",
      (m) => delete m.sources[0]!["header"],
      'books.uno: shop-orders has parts and no header · it has to say whether they have a header row, as one of "first", "none"',
    ],
    [
      "a header mode this build does not know, by name",
      (m) => (m.sources[0]!["header"] = "every"),
      'books.uno: shop-orders: this build does not know header "every" · it reads "first", "none"',
    ],
    [
      "a header mode that is not text",
      (m) => (m.sources[0]!["header"] = true),
      'books.uno: shop-orders: this build does not know header true · it reads "first", "none"',
    ],
    [
      "a _file column that is not a yes or a no",
      (m) => (m.sources[0]!["fileColumn"] = "yes"),
      "books.uno: shop-orders: fileColumn is neither true nor false",
    ],
    [
      "a path of its own beside its parts",
      (m) => (m.sources[0]!["path"] = "s3://acme-exports/shop/2025/orders.csv"),
      "books.uno: shop-orders has both a path and parts · a source is one file or several read as one",
    ],
    [
      "an entry of its own beside its parts",
      (m) => (m.sources[0]!["entry"] = "data/source/shop-orders.csv"),
      "books.uno: shop-orders has both an entry and parts · a source is one file or several read as one",
    ],
  ];

  test.each(refusals)("with %s", (_what, change, message) => {
    const uno = tampered(workspace([orders(), ...files()]), change);
    expect(() => readContainer("books.uno", uno, AT)).toThrow(new Error(message));
  });

  test("and a file source is still held to an entry or a path", () => {
    const uno = tampered(workspace([orders(), ...files()]), (m) => delete m.sources[1]!["path"]);
    expect(() => readContainer("books.uno", uno, AT)).toThrow(
      "books.uno: ledger.csv has no entry in this file and no path to the original",
    );
  });
});

// The format number is checked before anything else in the manifest.
describe("a format newer than this build reads", () => {
  const NEWER = FORMAT_VERSION + 1;

  test("is refused by name", () => {
    const uno = tampered(workspace([orders()]), (m) => (m.format = NEWER));
    expect(() => readContainer("books.uno", uno, AT)).toThrow(
      new Error(
        `books.uno was saved by a newer uno (format ${NEWER}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
      ),
    );
  });

  // The error is about the format even when the sources are also unreadable.
  test("is refused by name whatever it has done to its sources", () => {
    const uno = tampered(workspace([orders()]), (m) => {
      m.format = NEWER;
      m.sources = [{ id: "shop-orders", name: "shop-orders", stream: "kafka://orders" }];
    });
    expect(() => readContainer("books.uno", uno, AT)).toThrow(
      new Error(
        `books.uno was saved by a newer uno (format ${NEWER}, this build reads ${FORMAT_VERSION}). Update uno to open it`,
      ),
    );
    expect(() => readDocument("books.uno", uno, AT)).toThrow(`format ${NEWER}`);
  });
});
