// Parts must agree: a part that does not read the way the first part does is
// a refusal of the whole source, naming the part and what differs, whether it
// is found as the source opens or by the read that first reaches the part.

import { describe, expect, test } from "vite-plus/test";

import { bytesSource } from "../../src/store/index.ts";
import type { FileHandler, SingleRef } from "../../src/store/index.ts";
import { DisagreementError, openMulti } from "../../src/store/multi.ts";
import type { Disagreement, HeaderMode, MultiSource, Part } from "../../src/store/multi.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Where a file held in memory is said to be. */
const MEMORY = "memory://";

const UTF8_MARK = Uint8Array.of(0xef, 0xbb, 0xbf);
const UTF16LE_MARK = Uint8Array.of(0xff, 0xfe);
const UTF16BE_MARK = Uint8Array.of(0xfe, 0xff);

/** How many bytes a UTF-16 code unit is, and how far its high byte is shifted. */
const UTF16_UNIT_BYTES = 2;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;

/** A file as a test writes it: text, which is UTF-8, or the bytes themselves. */
type Content = string | Uint8Array;

function bytesOf(content: Content): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function concat(...pieces: Uint8Array[]): Uint8Array {
  return Uint8Array.from(pieces.flatMap((piece) => [...piece]));
}

/** `text` in UTF-16 with no byte order mark, low byte first or high byte first. */
function utf16(text: string, order: "le" | "be"): Uint8Array {
  const out = new Uint8Array(text.length * UTF16_UNIT_BYTES);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const low = unit & BYTE_MASK;
    const high = unit >> BYTE_BITS;
    out[i * UTF16_UNIT_BYTES] = order === "le" ? low : high;
    out[i * UTF16_UNIT_BYTES + 1] = order === "le" ? high : low;
  }
  return out;
}

/** "café" in Windows-1252, where é is one byte that is no UTF-8. */
const E_ACUTE_1252 = 0xe9;
function windows1252(before: string, after: string): Uint8Array {
  return concat(encoder.encode(before), Uint8Array.of(E_ACUTE_1252), encoder.encode(after));
}

/** The name of the file at `i`: a.csv, b.csv and on. */
function nameOf(i: number): string {
  return `${String.fromCharCode("a".charCodeAt(0) + i)}.csv`;
}

/** A handler over files held in memory, which remembers what it opened and closed. */
function memory(files: ReadonlyMap<string, Uint8Array>): {
  handler: FileHandler;
  opened: string[];
  closed: string[];
} {
  const opened: string[] = [];
  const closed: string[] = [];
  const handler: FileHandler = {
    label: "memory",
    handles: (ref) => "path" in ref && ref.path.startsWith(MEMORY),
    open(ref) {
      const held = files.get(ref.name);
      if (held === undefined) return Promise.reject(new Error(`${ref.name}: no such file`));
      opened.push(ref.name);
      const source = bytesSource(held);
      return Promise.resolve({
        size: source.size,
        read: (offset, length) => source.read(offset, length),
        close() {
          closed.push(ref.name);
          return Promise.resolve();
        },
      });
    },
  };
  return { handler, opened, closed };
}

function inMemory(name: string): SingleRef {
  return { name, path: MEMORY + name };
}

/** Files named a.csv, b.csv and on, and the parts that point at them. */
function held(contents: readonly Content[]): { files: Map<string, Uint8Array>; parts: Part[] } {
  return {
    files: new Map(contents.map((content, i) => [nameOf(i), bytesOf(content)])),
    parts: contents.map((_, i) => ({ ref: inMemory(nameOf(i)) })),
  };
}

function open(header: HeaderMode, contents: readonly Content[]): Promise<MultiSource> {
  const { files, parts } = held(contents);
  return openMulti([memory(files).handler], parts, header);
}

/** What `run` is refused with, which has to be a disagreement. */
async function refusal(run: () => Promise<unknown>): Promise<DisagreementError> {
  const err: unknown = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(err instanceof DisagreementError)) {
    throw new Error(`expected a DisagreementError, and got ${String(err)}`);
  }
  return err;
}

/**
 * Both ways a part that does not agree is found.
 *
 * `eager` is the source opened with nothing known of its parts, which opens
 * and checks every one. `lazy` is the source opened with the extents an
 * earlier open measured, when every part read as the first of `was` does:
 * part `at` has been written over since with `now`, and is not opened until a
 * read reaches it.
 */
async function refusals(
  header: HeaderMode,
  was: readonly Content[],
  at: number,
  now: Content,
): Promise<{ eager: DisagreementError; lazy: DisagreementError }> {
  const changed = was.map((content, i) => (i === at ? now : content));

  const eagerly = held(changed);
  const m = memory(eagerly.files);
  const eager = await refusal(() => openMulti([m.handler], eagerly.parts, header));
  expect(m.closed.toSorted(), "every part the refused open opened is closed").toEqual(
    m.opened.toSorted(),
  );

  const before = await open(header, was);
  const lazily = held(changed);
  const parts = lazily.parts.map((part, i) => ({ ...part, extent: before.extents[i]! }));
  const source = await openMulti([memory(lazily.files).handler], parts, header);
  const span = source.map.spans[at]!;
  const lazy = await refusal(() => source.read(span.start, span.end - span.start));

  return { eager, lazy };
}

interface Case {
  /** What the test is called. */
  title: string;
  /** The parts when they all agreed. */
  was: Content[];
  /** Which part is written over, counting from 0, and with what. */
  at: number;
  now: Content;
  message: string;
  differs: Disagreement;
}

const WITH_HEADER: Case[] = [
  {
    title: "a part with a renamed column is refused with both names",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n", "date,region,total\n3,E,7\n"],
    at: 1,
    now: "date,region,amount\n2,S,6\n",
    message: 'b.csv (part 2 of 3): column 3 is "amount" where a.csv has "total"',
    differs: { kind: "renamed", columns: [{ column: 2, first: "total", part: "amount" }] },
  },
  {
    title: "a name that differs only by a space at its end is shown in quotes",
    was: ["date,total\n1,5\n", "date,total\n2,6\n"],
    at: 1,
    now: "date,total \n2,6\n",
    message: 'b.csv (part 2 of 2): column 2 is "total " where a.csv has "total"',
    differs: { kind: "renamed", columns: [{ column: 1, first: "total", part: "total " }] },
  },
  {
    title: "several renamed columns are each named, up to three, and the rest counted",
    was: ["a,b,c,d,e\n1,2,3,4,5\n", "a,b,c,d,e\n1,2,3,4,5\n"],
    at: 1,
    now: "A,B,C,D,E\n1,2,3,4,5\n",
    message:
      'b.csv (part 2 of 2): column 1 is "A" where a.csv has "a" · ' +
      'column 2 is "B" where a.csv has "b" · ' +
      'column 3 is "C" where a.csv has "c" · and 2 more columns',
    differs: {
      kind: "renamed",
      columns: [
        { column: 0, first: "a", part: "A" },
        { column: 1, first: "b", part: "B" },
        { column: 2, first: "c", part: "C" },
        { column: 3, first: "d", part: "D" },
        { column: 4, first: "e", part: "E" },
      ],
    },
  },
  {
    title: "reordered columns are refused as reordered, naming each one out of place",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date,total,region\n2,6,S\n",
    message:
      "b.csv (part 2 of 2): its columns are in another order than a.csv's · " +
      'column 2 is "total" where a.csv has "region" · ' +
      'column 3 is "region" where a.csv has "total"',
    differs: {
      kind: "reordered",
      columns: [
        { column: 1, first: "region", part: "total" },
        { column: 2, first: "total", part: "region" },
      ],
    },
  },
  {
    title: "a missing column is named, with where the first part has it",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date,total\n2,6\n",
    message: 'b.csv (part 2 of 2): it has no "region", which is column 2 of a.csv',
    differs: { kind: "missing", columns: [{ column: 1, name: "region" }] },
  },
  {
    title: "a missing last column is named",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date,region\n2,S\n",
    message: 'b.csv (part 2 of 2): it has no "total", which is column 3 of a.csv',
    differs: { kind: "missing", columns: [{ column: 2, name: "total" }] },
  },
  {
    title: "an extra column is named, with where the part has it",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n", "date,region,total\n3,E,7\n"],
    at: 2,
    now: "date,region,notes,total\n3,E,late,7\n",
    message: 'c.csv (part 3 of 3): its column 3 is "notes", which a.csv does not have',
    differs: { kind: "extra", columns: [{ column: 2, name: "notes" }] },
  },
  {
    title: "a different number of columns that is neither is refused with both counts",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date,area\n2,S\n",
    message:
      "b.csv (part 2 of 2): it has 2 columns and a.csv has 3 · " +
      'column 2 is "area" where a.csv has "region"',
    differs: {
      kind: "columns",
      first: 3,
      part: 2,
      column: { column: 1, first: "region", part: "area" },
    },
  },
  {
    title: "a different delimiter is refused, with both in words",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date;region;total\n2;S;6\n",
    message: "b.csv (part 2 of 2): it is semicolon-separated and a.csv is comma-separated",
    differs: { kind: "delimiter", first: ",", part: ";" },
  },
  {
    title: "a tab-separated part among comma-separated ones is refused",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: "date\tregion\ttotal\n2\tS\t6\n",
    message: "b.csv (part 2 of 2): it is tab-separated and a.csv is comma-separated",
    differs: { kind: "delimiter", first: ",", part: "\t" },
  },
  {
    title: "a UTF-16 part with a byte order mark is refused, with both encodings",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: concat(UTF16LE_MARK, utf16("date,region,total\n2,S,6\n", "le")),
    message: "b.csv (part 2 of 2): its text encoding is UTF-16 little-endian and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "utf-16le" },
  },
  {
    title: "a big-endian UTF-16 part is refused",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: concat(UTF16BE_MARK, utf16("date,region,total\n2,S,6\n", "be")),
    message: "b.csv (part 2 of 2): its text encoding is UTF-16 big-endian and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "utf-16be" },
  },
  {
    title: "a UTF-16 part with no byte order mark is refused",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: utf16("date,region,total\n2,S,6\n", "le"),
    message: "b.csv (part 2 of 2): its text encoding is UTF-16 little-endian and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "utf-16le" },
  },
  {
    title: "a part that is no kind of Unicode is refused, though its header is the same",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: windows1252("date,region,total\n2,Orl", "ans,6\n"),
    message:
      "b.csv (part 2 of 2): its text encoding is neither UTF-8 nor UTF-16 and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "other" },
  },
  {
    title: "the encoding is what is named where the delimiter and header differ as well",
    was: ["date,region,total\n1,N,5\n", "date,region,total\n2,S,6\n"],
    at: 1,
    now: concat(UTF16LE_MARK, utf16("day;area\n2;S\n", "le")),
    message: "b.csv (part 2 of 2): its text encoding is UTF-16 little-endian and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "utf-16le" },
  },
];

const WITH_NO_HEADER: Case[] = [
  {
    title: "a first row with another number of columns is refused with both counts",
    was: ["1,N,5\n2,S,6\n", "3,E,7\n", "4,W,8\n"],
    at: 2,
    now: "4,W,8,late\n",
    message: "c.csv (part 3 of 3): its first row has 4 columns and a.csv's has 3",
    differs: { kind: "fields", first: 3, part: 4 },
  },
  {
    title: "a first row of one column is said in the singular",
    was: ["1,5\n2,6\n", "3,7\n"],
    at: 1,
    now: "3\n",
    message: "b.csv (part 2 of 2): its first row has 1 column and a.csv's has 2",
    differs: { kind: "fields", first: 2, part: 1 },
  },
  {
    title: "a different delimiter is refused, with both in words",
    was: ["1,N,5\n2,S,6\n", "3,E,7\n4,W,8\n"],
    at: 1,
    now: "3|E|7\n4|W|8\n",
    message: "b.csv (part 2 of 2): it is pipe-separated and a.csv is comma-separated",
    differs: { kind: "delimiter", first: ",", part: "|" },
  },
  {
    title: "a different encoding is refused, with both encodings",
    was: ["1,N,5\n2,S,6\n", "3,E,7\n4,W,8\n"],
    at: 1,
    now: concat(UTF16LE_MARK, utf16("3,E,7\n4,W,8\n", "le")),
    message: "b.csv (part 2 of 2): its text encoding is UTF-16 little-endian and a.csv's is UTF-8",
    differs: { kind: "encoding", first: "utf-8", part: "utf-16le" },
  },
];

const MODES: Array<[string, HeaderMode, Case[]]> = [
  ["with a header row", "first", WITH_HEADER],
  ["with no header row", "none", WITH_NO_HEADER],
];

for (const [mode, header, cases] of MODES) {
  describe(mode, () => {
    for (const c of cases) {
      test(c.title, async () => {
        const { eager, lazy } = await refusals(header, c.was, c.at, c.now);
        for (const [path, err] of [
          ["as the source opens", eager],
          ["when a read reaches the part", lazy],
        ] as const) {
          expect(err.message, path).toBe(c.message);
          expect(err.differs, path).toEqual(c.differs);
          expect(err.part, path).toBe(c.at);
          expect(err.partName, path).toBe(nameOf(c.at));
          expect(err.firstName, path).toBe(nameOf(0));
        }
      });
    }
  });
}

test("with no header row, the names in the first rows are free to differ", async () => {
  const source = await open("none", ["1,N,5\n", "2,S,6\n"]);
  expect(decoder.decode(await source.read(0, source.size))).toBe("1,N,5\n2,S,6\n");
});

test("a byte order mark is not a different encoding, on the first part or a later one", async () => {
  const header = "date,total\n";
  const marked = concat(UTF8_MARK, encoder.encode(`${header}2,6\n`));
  for (const contents of [
    [`${header}1,5\n`, marked],
    [marked, `${header}1,5\n`],
  ]) {
    const source = await open("first", contents);
    expect(decoder.decode(await source.read(source.map.spans[1]!.start, source.size))).toMatch(
      /^\d,\d\n$/,
    );
  }
  const none = await open("none", ["1,5\n", concat(UTF8_MARK, encoder.encode("2,6\n"))]);
  expect(decoder.decode(await none.read(0, none.size))).toBe("1,5\n2,6\n");
});

test("parts in UTF-8 agree whether or not each has a character past ASCII", async () => {
  const source = await open("first", ["city,total\nLyon,5\n", "city,total\nOrléans,6\n"]);
  expect(decoder.decode(await source.read(0, source.size))).toBe("city,total\nLyon,5\nOrléans,6\n");
});

test("with no header row, a part of blank lines has no row to hold to the first part's", async () => {
  const source = await open("none", ["1,2\n", "\n\n", "3,4\n"]);
  expect(decoder.decode(await source.read(0, source.size))).toBe("1,2\n\n\n3,4\n");
});

test("with no header row, a first part with no row in it holds the others to nothing", async () => {
  const source = await open("none", ["\n", "1,2\n", "3;4\n"]);
  expect(decoder.decode(await source.read(0, source.size))).toBe("\n1,2\n3;4\n");
});

test("the first part that does not agree is the one refused, in the order of the parts", async () => {
  const { files, parts } = held(["a,b\n1,2\n", "a,c\n3,4\n", "a;b\n5;6\n"]);
  const one = [memory(files).handler];
  // One at a time, so the order they are checked in is the order they are in.
  const second = await refusal(() => openMulti(one, parts.slice(0, 2), "first"));
  expect(second.partName).toBe("b.csv");
  const third = await refusal(() => openMulti(one, [parts[0]!, parts[2]!], "first"));
  expect(third.message).toBe(
    "c.csv (part 2 of 2): it is semicolon-separated and a.csv is comma-separated",
  );
});

test("a part found not to agree by a read refuses every read of the source after it", async () => {
  const was = ["a,b\n1,2\n", "a,b\n3,4\n", "a,b\n5,6\n"];
  const before = await open("first", was);
  const { files, parts } = held([was[0]!, "a,c\n3,4\n", was[2]!]);
  const m = memory(files);
  const source = await openMulti(
    [m.handler],
    parts.map((part, i) => ({ ...part, extent: before.extents[i]! })),
    "first",
  );
  expect(m.opened, "nothing is opened, so nothing is refused yet").toEqual([]);

  const [first, second, third] = source.map.spans;
  // Until a read reaches the part, the parts before and after it read.
  expect(decoder.decode(await source.read(first!.start, first!.end))).toBe(was[0]);

  const found = await refusal(() => source.read(second!.start, 1));
  expect(found.message).toBe('b.csv (part 2 of 3): column 2 is "c" where a.csv has "b"');

  // And from then on the source is refused, whichever part is asked for.
  expect(await refusal(() => source.read(first!.start, 1))).toBe(found);
  expect(await refusal(() => source.read(third!.start, 1))).toBe(found);
  expect(m.opened, "the part past it was never opened").toEqual(["a.csv", "b.csv"]);

  await source.close();
  expect(m.closed.toSorted()).toEqual(["a.csv", "b.csv"]);
});
