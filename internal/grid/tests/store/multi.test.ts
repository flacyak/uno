// Several files read as one: the three parts of sales-q3.csv read back as the
// whole file, wherever a read starts and however far it goes, with each part
// opened only when a read needs it and every byte traceable to its part.

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { blobFiles, bytesSource } from "../../src/store/index.ts";
import type { FileHandler, FileRef } from "../../src/store/index.ts";
import { openMulti, partMap } from "../../src/store/multi.ts";
import type { Extent, HeaderMode, Part } from "../../src/store/multi.ts";
import { localFiles } from "../../src/store/node.ts";
import { s3Files } from "../../src/store/s3.ts";
import { bytes } from "../testdata/sales-q3.ts";
import { PARTS, PART_FIXTURES, PART_NAMES, partBytes } from "../testdata/sales-q3-parts.ts";
import { HOME_REGION } from "./regions.ts";
import { KEYS, at, bucket, etagOf } from "./standin.ts";
import type { Bucket } from "./standin.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const LF = 0x0a;
const CRLF_BYTES = 2;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

/** The header line every part of the fixture opens with, its CRLF included. */
const HEADER_BYTES = partBytes[0]!.indexOf(LF) + 1;

/** Where a file held in memory is said to be. */
const MEMORY = "memory://";

/** A handler over files held in memory, which remembers what was asked of it. */
function memory(files: ReadonlyMap<string, Uint8Array>): {
  handler: FileHandler;
  /** The name of every file opened, in the order they were. */
  opened: string[];
  closed: string[];
  /** Every ref an open was handed, as it came. */
  refs: FileRef[];
  /** Every read: which file, where, how much. */
  reads: Array<{ name: string; offset: number; length: number }>;
} {
  const opened: string[] = [];
  const closed: string[] = [];
  const refs: FileRef[] = [];
  const reads: Array<{ name: string; offset: number; length: number }> = [];
  const handler: FileHandler = {
    label: "memory",
    handles: (ref) => "path" in ref && ref.path.startsWith(MEMORY),
    open(ref) {
      const held = files.get(ref.name);
      if (held === undefined) return Promise.reject(new Error(`${ref.name}: no such file`));
      opened.push(ref.name);
      refs.push(ref);
      const source = bytesSource(held);
      return Promise.resolve({
        size: source.size,
        version: `"${ref.name}"`,
        read(offset, length) {
          reads.push({ name: ref.name, offset, length });
          return source.read(offset, length);
        },
        close() {
          closed.push(ref.name);
          return Promise.resolve();
        },
      });
    },
  };
  return { handler, opened, closed, refs, reads };
}

function inMemory(name: string): FileRef {
  return { name, path: MEMORY + name };
}

/** The fixture's three parts, held in memory. */
function fixtureFiles(): Map<string, Uint8Array> {
  return new Map(PART_NAMES.map((name, i) => [name, partBytes[i]!]));
}

/** Files of text, named a.csv, b.csv and on, and the parts that point at them. */
function texts(...contents: string[]): { files: Map<string, Uint8Array>; parts: Part[] } {
  const names = contents.map((_, i) => `${String.fromCharCode("a".charCodeAt(0) + i)}.csv`);
  return {
    files: new Map(names.map((name, i) => [name, encoder.encode(contents[i]!)])),
    parts: names.map((name) => ({ ref: inMemory(name) })),
  };
}

/** What the parts read as, joined, as text. */
async function joined(header: HeaderMode, ...contents: string[]): Promise<string> {
  const { files, parts } = texts(...contents);
  const source = await openMulti([memory(files).handler], parts, header);
  return decoder.decode(await source.read(0, source.size));
}

/** The fixture's parts with the extents an earlier open measured. */
async function measuredParts(): Promise<Part[]> {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([memory(fixtureFiles()).handler], parts, "first");
  return parts.map((part, i) => ({ ...part, extent: source.extents[i]! }));
}

/** A generator of the same numbers every run, each from 0 up to but not 1. */
function seeded(seed: number): () => number {
  const MODULUS = 2 ** 32;
  const MULTIPLIER = 1664525;
  const INCREMENT = 1013904223;
  let state = seed;
  return () => {
    state = (state * MULTIPLIER + INCREMENT) % MODULUS;
    return state / MODULUS;
  };
}

// The task's own sentence.
test("sales-q3.csv split into three parts reads back identical to the whole", async () => {
  const parts = PART_FIXTURES.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } }));
  const source = await openMulti([localFiles()], parts, "first");
  try {
    expect(source.size).toBe(bytes.length);
    expect(Buffer.from(await source.read(0, source.size)).equals(Buffer.from(bytes))).toBe(true);
  } finally {
    await source.close();
  }
});

test("a read is the same bytes of the whole, wherever it starts and however long it is", async () => {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([memory(fixtureFiles()).handler], parts, "first");
  const random = seeded(3);
  const LONGEST = 100_000;
  const READS = 400;
  for (let n = 0; n < READS; n++) {
    const offset = Math.floor(random() * bytes.length);
    const length = Math.floor(random() * LONGEST);
    expect(
      Buffer.from(await source.read(offset, length)).equals(
        Buffer.from(bytes.subarray(offset, offset + length)),
      ),
      `${length} bytes from ${offset}`,
    ).toBe(true);
  }
});

test("a read across a boundary takes up in the next part where the last one left off", async () => {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([memory(fixtureFiles()).handler], parts, "first");
  const text = (offset: number, length: number): string =>
    decoder.decode(bytes.subarray(offset, offset + length));
  const AROUND = 40;
  for (const { start } of source.map.spans.slice(1)) {
    for (const before of [1, 2, AROUND]) {
      for (const length of [before, before + 1, before + AROUND]) {
        expect(
          decoder.decode(await source.read(start - before, length)),
          `${length} bytes from ${before} before ${start}`,
        ).toBe(text(start - before, length));
      }
    }
  }
  // One read over both boundaries, and one that asks for more than there is.
  const [, second, third] = source.map.spans;
  const over = third!.start - second!.start + 2 * AROUND;
  expect(decoder.decode(await source.read(second!.start - AROUND, over))).toBe(
    text(second!.start - AROUND, over),
  );
  expect((await source.read(source.size - AROUND, 2 * AROUND)).length).toBe(AROUND);
  expect((await source.read(source.size, AROUND)).length).toBe(0);
});

// The way indexing reads: front to back in chunks that fit no part.
test("read front to back in chunks, the join is the whole", async () => {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([memory(fixtureFiles()).handler], parts, "first");
  const CHUNK = 4099;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < source.size; offset += CHUNK) {
    chunks.push(await source.read(offset, Math.min(CHUNK, source.size - offset)));
  }
  expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
});

test("a part that does not end in a newline is given one before the next part", async () => {
  expect(await joined("first", "a,b\n1,2", "a,b\n3,4", "a,b\n5,6\n")).toBe("a,b\n1,2\n3,4\n5,6\n");

  // In the fixture: part two loses the CRLF of its last row, and reads back
  // with a newline there, so the whole differs by that row's CR and no more.
  const files = fixtureFiles();
  const cut = partBytes[1]!.subarray(0, partBytes[1]!.length - CRLF_BYTES);
  files.set(PART_NAMES[1]!, cut);
  const source = await openMulti(
    [memory(files).handler],
    PART_NAMES.map((name) => ({ ref: inMemory(name) })),
    "first",
  );
  expect(source.extents.map((e) => e.unterminated)).toEqual([false, true, false]);
  expect(source.map.spans.map((s) => s.newline)).toEqual([false, true, false]);
  // Where part two's last row ends in the whole file, after its CRLF.
  const boundary = source.map.spans[1]!.end + 1;
  const expected = Buffer.concat([
    bytes.subarray(0, boundary - CRLF_BYTES),
    Uint8Array.of(LF),
    bytes.subarray(boundary),
  ]);
  expect(Buffer.from(await source.read(0, source.size)).equals(expected)).toBe(true);
});

test("the last part is left to end the way it ends", async () => {
  expect(await joined("first", "a,b\n1,2\n", "a,b\n3,4")).toBe("a,b\n1,2\n3,4");
  // Until a part is added after it.
  expect(await joined("first", "a,b\n1,2\n", "a,b\n3,4", "a,b\n5,6")).toBe("a,b\n1,2\n3,4\n5,6");
});

test("a read of a virtual newline alone, or with what is either side of it, is right", async () => {
  const { files, parts } = texts("a,b\n1,2", "a,b\n3,4\n");
  const source = await openMulti([memory(files).handler], parts, "first");
  const whole = "a,b\n1,2\n3,4\n";
  for (let offset = 0; offset < whole.length; offset++) {
    for (let length = 1; offset + length <= whole.length; length++) {
      expect(
        decoder.decode(await source.read(offset, length)),
        `${length} bytes from ${offset}`,
      ).toBe(whole.slice(offset, offset + length));
    }
  }
});

test("a header that is all a part holds is left out, and the part gives no rows", async () => {
  expect(await joined("first", "a,b\n1,2\n", "a,b\n", "a,b\n3,4\n")).toBe("a,b\n1,2\n3,4\n");
  expect(await joined("first", "a,b\n1,2\n", "a,b", "a,b\n3,4\n")).toBe("a,b\n1,2\n3,4\n");
  expect(await joined("first", "a,b\n1,2\n", "", "a,b\n3,4\n")).toBe("a,b\n1,2\n3,4\n");
  // A first part that is only the header still ends its line.
  expect(await joined("first", "a,b", "a,b\n1,2\n")).toBe("a,b\n1,2\n");
});

test("a repeated header is the same header however it is written", async () => {
  expect(await joined("first", "a,b\r\n1,2\r\n", '"a","b"\n3,4\n')).toBe("a,b\r\n1,2\r\n3,4\n");
  // A byte order mark in front of a later part's header goes with the header.
  const { files, parts } = texts("a,b\n1,2\n", "a,b\n3,4\n");
  files.set("b.csv", Uint8Array.of(...BOM, ...files.get("b.csv")!));
  const source = await openMulti([memory(files).handler], parts, "first");
  expect(decoder.decode(await source.read(0, source.size))).toBe("a,b\n1,2\n3,4\n");
});

test("with no header row, nothing is skipped", async () => {
  expect(await joined("none", "1,2\n3,4\n", "1,2\n5,6", "7,8\n")).toBe("1,2\n3,4\n1,2\n5,6\n7,8\n");

  // The fixture's parts read that way keep all three of their headers.
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([memory(fixtureFiles()).handler], parts, "none");
  expect(source.extents.map((e) => e.skip)).toEqual([0, 0, 0]);
  expect(Buffer.from(await source.read(0, source.size)).equals(Buffer.concat(partBytes))).toBe(
    true,
  );
});

// In the middle of the join a byte order mark would be a character of a cell.
test("with no header row, a later part's byte order mark is still left out", async () => {
  const { files, parts } = texts("1,2\n", "3,4\n");
  for (const [name, held] of files) files.set(name, Uint8Array.of(...BOM, ...held));
  const source = await openMulti([memory(files).handler], parts, "none");
  expect(source.extents.map((e) => e.skip)).toEqual([0, BOM.length]);
  expect(
    Buffer.from(await source.read(0, source.size)).equals(
      Buffer.from(Uint8Array.of(...BOM, ...encoder.encode("1,2\n3,4\n"))),
    ),
  ).toBe(true);
});

test("a part is opened when the source opens only where nothing says its extent", async () => {
  const m = memory(fixtureFiles());
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([m.handler], parts, "first");
  expect(m.opened.toSorted()).toEqual([...PART_NAMES]);
  // And once: every read after is of a part already open.
  await source.read(0, source.size);
  await source.versions();
  expect(m.opened).toHaveLength(PARTS);
});

test("a part with its extent is not opened until a read needs it", async () => {
  const parts = await measuredParts();
  const m = memory(fixtureFiles());
  const source = await openMulti([m.handler], parts, "first");
  expect(m.opened, "opening the source opens no part").toEqual([]);
  expect(source.size).toBe(bytes.length);

  const [first, second, third] = source.map.spans;
  await source.read(first!.start, HEADER_BYTES);
  expect(m.opened).toEqual([PART_NAMES[0]]);
  await source.read(first!.end - 1, 1);
  expect(m.opened, "up to the last byte of the first part").toEqual([PART_NAMES[0]]);

  await source.read(third!.start, HEADER_BYTES);
  expect(m.opened, "the third, and never the second").toEqual([PART_NAMES[0], PART_NAMES[2]]);

  await source.read(second!.end - 1, 2);
  expect(m.opened).toEqual([PART_NAMES[0], PART_NAMES[2], PART_NAMES[1]]);
  expect(Buffer.from(await source.read(0, source.size)).equals(Buffer.from(bytes))).toBe(true);
  expect(m.opened, "each part once").toHaveLength(PARTS);
});

// The first part's header is what a later part is held to, so the first part
// is opened with it.
test("a later part read first is opened with the first part, and no other", async () => {
  const parts = await measuredParts();
  const m = memory(fixtureFiles());
  const source = await openMulti([m.handler], parts, "first");
  const third = source.map.spans[2]!;
  const read = await source.read(third.start, HEADER_BYTES);
  expect(decoder.decode(read)).toBe(
    decoder.decode(bytes.subarray(third.start, third.start + HEADER_BYTES)),
  );
  expect(m.opened.toSorted()).toEqual([PART_NAMES[0], PART_NAMES[2]]);
});

// With no header row it is still held to the first part's delimiter, encoding
// and number of columns.
test("with no header row, a later part read first is opened with the first part too", async () => {
  const m = memory(fixtureFiles());
  const unmeasured = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const { extents } = await openMulti([memory(fixtureFiles()).handler], unmeasured, "none");
  const parts = unmeasured.map((part, i) => ({ ...part, extent: extents[i]! }));
  const source = await openMulti([m.handler], parts, "none");
  await source.read(source.map.spans[1]!.start, HEADER_BYTES);
  expect(m.opened.toSorted()).toEqual([PART_NAMES[0], PART_NAMES[1]]);
});

test("a virtual newline is read without opening the part it ends", async () => {
  const { files, parts } = texts("1,2", "3,4\n");
  const extents: Extent[] = [
    { bytes: 3, skip: 0, unterminated: true },
    { bytes: 4, skip: 0, unterminated: false },
  ];
  const m = memory(files);
  const source = await openMulti(
    [m.handler],
    parts.map((part, i) => ({ ...part, extent: extents[i]! })),
    "none",
  );
  expect(decoder.decode(await source.read(3, 1))).toBe("\n");
  expect(m.opened).toEqual([]);
});

test("the map says which part every byte came from, at every boundary", async () => {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const { map, size } = await openMulti([memory(fixtureFiles()).handler], parts, "first");

  expect(map.size).toBe(size);
  expect(map.spans.map((s) => s.part)).toEqual([0, 1, 2]);
  // The first part is there whole, and each later one without its header.
  expect(map.spans.map((s) => s.skip)).toEqual([0, HEADER_BYTES, HEADER_BYTES]);
  expect(map.spans.map((s) => s.end - s.start)).toEqual(
    partBytes.map((held, i) => held.length - (i === 0 ? 0 : HEADER_BYTES)),
  );
  expect(map.spans[0]!.start).toBe(0);
  expect(map.spans.at(-1)!.end).toBe(size);

  for (const [i, span] of map.spans.entries()) {
    expect(map.partAt(span.start), `the first byte of part ${i}`).toBe(i);
    expect(map.partAt(span.end - 1), `the last byte of part ${i}`).toBe(i);
    if (i > 0) {
      expect(span.start, "each starts where the last one ended").toBe(map.spans[i - 1]!.end);
      expect(map.partAt(span.start - 1), `the byte before part ${i}`).toBe(i - 1);
    }
  }
  expect(map.partAt(-1)).toBeUndefined();
  expect(map.partAt(size)).toBeUndefined();
  expect(map.partAt(Number.NaN)).toBeUndefined();
});

// What the _file column goes on: a row is in the part its first byte is in.
test("the map puts every row of the fixture in the part that holds it", async () => {
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const { map } = await openMulti([memory(fixtureFiles()).handler], parts, "first");
  const counts = Array.from({ length: PARTS }, () => 0);
  for (let at = HEADER_BYTES; at < bytes.length; at = bytes.indexOf(LF, at) + 1) {
    const part = map.partAt(at)!;
    counts[part]!++;
    // The row is in that part's own bytes, at the offset the span says.
    const span = map.spans[part]!;
    const within = span.skip + (at - span.start);
    expect(partBytes[part]![within]).toBe(bytes[at]);
  }
  const rows = (held: Uint8Array): number => held.filter((b) => b === LF).length - 1;
  expect(counts).toEqual(partBytes.map(rows));
});

test("the map lays out a virtual newline, and a part that gives nothing", () => {
  const map = partMap([
    { bytes: 10, skip: 0, unterminated: true },
    { bytes: 4, skip: 4, unterminated: true },
    { bytes: 0, skip: 0, unterminated: false },
    { bytes: 9, skip: 4, unterminated: true },
  ]);
  expect(map.spans).toEqual([
    { part: 0, start: 0, end: 11, skip: 0, newline: true },
    { part: 1, start: 11, end: 11, skip: 4, newline: false },
    { part: 2, start: 11, end: 11, skip: 0, newline: false },
    { part: 3, start: 11, end: 16, skip: 4, newline: false },
  ]);
  expect(map.size).toBe(16);
  expect(map.partAt(9)).toBe(0);
  // The virtual newline belongs to the part it ends.
  expect(map.partAt(10)).toBe(0);
  // No byte is in a part that gives nothing.
  expect(map.partAt(11)).toBe(3);
  expect(map.partAt(15)).toBe(3);
  expect(map.partAt(16)).toBeUndefined();
  expect(partMap([]).partAt(0)).toBeUndefined();
});

test("a part whose header is not the first part's is refused by name", async () => {
  const { files, parts } = texts("a,b\n1,2\n", "a,b\n3,4\n", "a,c\n5,6\n");
  const m = memory(files);
  await expect(openMulti([m.handler], parts, "first")).rejects.toThrow(
    'c.csv (part 3 of 3): column 2 is "c" where a.csv has "b"',
  );
  expect(m.closed.toSorted(), "and what it opened is closed").toEqual(m.opened.toSorted());
});

test("a part that cannot be opened is named", async () => {
  const { files, parts } = texts("a,b\n1,2\n", "a,b\n3,4\n");
  files.delete("b.csv");
  const m = memory(files);
  await expect(openMulti([m.handler], parts, "first")).rejects.toThrow(
    "b.csv (part 2 of 2): b.csv: no such file",
  );
  expect(m.closed).toEqual(m.opened);
  // A part no handler listed opens is refused the way any ref is, by part.
  await expect(
    openMulti([m.handler], [parts[0]!, { ref: { name: "c.csv", path: "/tmp/c.csv" } }], "first"),
  ).rejects.toThrow(/^c\.csv \(part 2 of 2\): /);
  await expect(openMulti([m.handler], [], "first")).rejects.toThrow("at least one part");
});

test("a part that is not what its extent says is refused when a read reaches it", async () => {
  const parts = await measuredParts();
  const files = fixtureFiles();
  const longer = Uint8Array.of(...partBytes[1]!, ...encoder.encode("2026-09-30,West\r\n"));
  files.set(PART_NAMES[1]!, longer);
  const m = memory(files);
  const source = await openMulti([m.handler], parts, "first");
  const [first, second] = source.map.spans;
  expect((await source.read(first!.start, HEADER_BYTES)).length).toBe(HEADER_BYTES);
  await expect(source.read(second!.start, HEADER_BYTES)).rejects.toThrow(
    `${PART_NAMES[1]} (part 2 of 3): it is not the file this source was made from · it is ${longer.length} bytes and was ${partBytes[1]!.length}`,
  );
  expect(m.closed, "and it is not left open").toEqual([PART_NAMES[1]]);

  // Put back, it reads: a failed open is asked for again.
  files.set(PART_NAMES[1]!, partBytes[1]!);
  expect((await source.read(second!.start, HEADER_BYTES)).length).toBe(HEADER_BYTES);
});

test("a part that comes up short under a read is named", async () => {
  const held = new Map(fixtureFiles());
  const SHORT = 100;
  const handler: FileHandler = {
    label: "memory",
    handles: () => true,
    open(ref) {
      const source = bytesSource(held.get(ref.name)!);
      // The file as it was when it was opened, cut short under the reader.
      const cut = ref.name === PART_NAMES[2];
      return Promise.resolve({
        ...source,
        read: (offset, length) =>
          source.read(
            offset,
            cut && offset + length < source.size ? Math.min(length, SHORT) : length,
          ),
      });
    },
  };
  const parts = PART_NAMES.map((name) => ({ ref: inMemory(name) }));
  const source = await openMulti([handler], parts, "none");
  await expect(source.read(source.map.spans[2]!.start, 2 * SHORT)).rejects.toThrow(
    `${PART_NAMES[2]} (part 3 of 3): it changed since it was opened`,
  );
});

test("each part is asked for as its ref says, version and all, and says its own", async () => {
  const m = memory(fixtureFiles());
  const parts: Part[] = PART_NAMES.map((name, i) => ({
    ref: { ...inMemory(name), version: `saved-${i}` },
  }));
  const source = await openMulti([m.handler], parts, "first");
  expect(m.refs.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual(parts.map((p) => p.ref));
  expect(source.version).toBeUndefined();
  expect(await source.versions()).toEqual(PART_NAMES.map((name) => `"${name}"`));
});

test("closing closes each part that was opened, and no other", async () => {
  const parts = await measuredParts();
  const m = memory(fixtureFiles());
  const source = await openMulti([m.handler], parts, "first");
  await source.read(source.map.spans[2]!.start, HEADER_BYTES);
  await source.close();
  expect(m.closed.toSorted()).toEqual([PART_NAMES[0], PART_NAMES[2]]);
});

// Any handler, in any mix: a file on disk, an object in a bucket, and bytes
// already in hand, as one table.
const KEY = `2025/${PART_NAMES[1]}`;
let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, new Map([[KEY, partBytes[1]!]]));
});
afterAll(() => b.close());

function mixed(): { handlers: FileHandler[]; parts: Part[] } {
  return {
    handlers: [
      s3Files({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint }),
      localFiles(),
      blobFiles(),
    ],
    parts: [
      { ref: { name: PART_NAMES[0]!, path: PART_FIXTURES[0]! } },
      { ref: at(KEY) },
      { ref: { name: PART_NAMES[2]!, blob: new Blob([partBytes[2]!.slice()]) } },
    ],
  };
}

test("a file on disk, an object in a bucket and dropped bytes read as one", async () => {
  const { handlers, parts } = mixed();
  const source = await openMulti(handlers, parts, "first");
  try {
    expect(Buffer.from(await source.read(0, source.size)).equals(Buffer.from(bytes))).toBe(true);
    expect(await source.versions()).toEqual([undefined, etagOf(partBytes[1]!), undefined]);
  } finally {
    await source.close();
  }
});

test("an object written over while it is being read is an error that names the part", async () => {
  const { handlers, parts } = mixed();
  const source = await openMulti(handlers, parts, "first");
  try {
    const [first, second] = source.map.spans;
    // Another export the same size: only the version says it changed.
    b.objects.set(
      KEY,
      partBytes[1]!.map((byte) => (byte === LF ? LF : byte ^ 1)),
    );
    await expect(source.read(second!.start, HEADER_BYTES)).rejects.toThrow(
      `${PART_NAMES[1]} (part 2 of 3): ${at(KEY).path} changed in the bucket since it was opened · open it again`,
    );
    // The parts around it still read.
    expect((await source.read(first!.start, HEADER_BYTES)).length).toBe(HEADER_BYTES);
  } finally {
    b.objects.set(KEY, partBytes[1]!);
    await source.close();
  }
});
