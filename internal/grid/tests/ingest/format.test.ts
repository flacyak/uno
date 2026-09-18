import { describe, expect, test } from "vite-plus/test";

import {
  delimiterName,
  encodingName,
  headerOf,
  openFormat,
  peekFormat,
  read,
  sniffEncoding,
} from "../../src/ingest/index.ts";
import type { Encoding } from "../../src/ingest/index.ts";
import { blobSource } from "../../src/store/index.ts";

/** What ingest/format.ts reads of a file before it knows how long the header is. */
const PEEK = 64 << 10;

const encoder = new TextEncoder();

function open(name: string, text: string) {
  return openFormat(name, blobSource(new Blob([text])));
}

// A file opened through the engine and the same file read whole have to say the
// same thing about themselves, or the status bar changes when a person switches
// mode.
describe("openFormat reads the head the way read reads the file", () => {
  const cases: Array<[string, string]> = [
    ["f.csv", "a,b,c\n1,2,3\n"],
    ["f.csv", "a;b;c\n1;2;3\n"],
    ["f.csv", "a|b|c\n1|2|3\n"],
    ["f.csv", "a\tb\tc\n1\t2\t3\n"],
    ["f.tsv", "a\tb\n1\t2\n"],
    ["f.csv", 'name,role\n"Okafor, Ada",lead\n'],
    ["f.csv", "sku,product_cost,price,product_cost\nA,1,5,2\n"],
  ];

  for (const [name, text] of cases) {
    test(JSON.stringify(text), async () => {
      const f = await open(name, text);
      const s = read(name, text);
      expect(f.label).toBe(s.source);
      expect(f.columns).toEqual(s.columns.map((c) => c.header));
    });
  }
});

test("the data starts after the header record, blank lines and all", async () => {
  const head = '"a\nb",c\r\n\r\n';
  const f = await open("f.csv", `${head}1,2\n`);
  expect(f.columns).toEqual(["a\nb", "c"]);
  expect(f.dataStart).toBe(encoder.encode(head).length);
});

test("a header with no rows under it starts its data at the end of the file", async () => {
  const head = "a,b,c\n";
  const f = await open("f.csv", head);
  expect(f.columns).toEqual(["a", "b", "c"]);
  expect(f.dataStart).toBe(encoder.encode(head).length);
});

test("the byte order mark is not part of the first column's name", async () => {
  const head = "\uFEFFa,b\n";
  const f = await open("f.csv", `${head}1,2\n`);
  expect(f.columns).toEqual(["a", "b"]);
  expect(f.dataStart).toBe(encoder.encode(head).length);
});

// Longer than the first read, so the header has to be read again.
test("a header longer than the first read is still read whole", async () => {
  const names = Array.from({ length: 5000 }, (_, i) => `column number ${i}`);
  const header = names.join(",");
  expect(header.length).toBeGreaterThan(PEEK);
  const f = await open("wide.csv", `${header}\n1,2\n`);
  expect(f.columns).toEqual(names);
  expect(f.dataStart).toBe(header.length + 1);
});

test("decode reads a run of records the way readAll does", async () => {
  const f = await open("f.csv", "a,b\n");
  expect(f.decode(encoder.encode('1,"x\ny"\n\n3,4'))).toEqual([
    ["1", "x\ny"],
    ["3", "4"],
  ]);
});

describe("openFormat names the file in every error", () => {
  const cases: Array<[string, string, string]> = [
    ["empty.csv", "", "empty.csv: file is empty"],
    ["blank.csv", "\n\r\n", "blank.csv: file is empty"],
    ["data.json", "[]", "data.json: JSON is not supported yet"],
  ];

  for (const [name, text, want] of cases) {
    test(name, async () => {
      await expect(open(name, text)).rejects.toThrow(want);
    });
  }
});

// A name two columns share is a name no formula can use, so every column gets
// its own, and the first one keeps what the file called it.
describe("headerOf names every column once", () => {
  const cases: Array<[string[], string[]]> = [
    [
      ["a", "b"],
      ["a", "b"],
    ],
    [
      ["cost", "price", "cost"],
      ["cost", "price", "cost_2"],
    ],
    [
      ["cost", "cost", "cost"],
      ["cost", "cost_2", "cost_3"],
    ],
    [
      ["cost", "cost_2", "cost"],
      ["cost", "cost_2", "cost_3"],
    ],
    [
      ["cost", "cost", "cost_2"],
      ["cost", "cost_3", "cost_2"],
    ],
    [
      ["", ""],
      ["", "_2"],
    ],
  ];

  for (const [header, want] of cases) {
    test(JSON.stringify(header), () => {
      expect(headerOf(header)).toEqual(want);
    });
  }
});

describe("openFormat says the delimiter and the encoding it found", () => {
  const cases: Array<[string, string, string]> = [
    ["f.csv", "a,b,c\n1,2,3\n", ","],
    ["f.csv", "a;b;c\n1;2;3\n", ";"],
    ["f.csv", "a|b|c\n1|2|3\n", "|"],
    ["f.csv", "a\tb\tc\n1\t2\t3\n", "\t"],
    ["f.tsv", "a,b\n1,2\n", "\t"],
    ["f.csv", "one column\n1\n", ","],
  ];

  for (const [name, text, delimiter] of cases) {
    test(`${name} ${JSON.stringify(text)}`, async () => {
      const f = await open(name, text);
      expect(f.delimiter).toBe(delimiter);
      expect(f.encoding).toBe("utf-8");
    });
  }

  test("a file that is not UTF-8", async () => {
    const latin = Uint8Array.of(...encoder.encode("a,b\ncaf"), E_ACUTE_1252, LF);
    const f = await openFormat("f.csv", blobSource(new Blob([latin])));
    expect(f.encoding).toBe("other");
  });
});

/** é in Windows-1252, one byte that is no UTF-8. */
const E_ACUTE_1252 = 0xe9;
const LF = 0x0a;

describe("sniffEncoding reads the encoding off the head", () => {
  const cases: Array<[string, number[], Encoding]> = [
    ["nothing at all", [], "utf-8"],
    ["plain ASCII", [...encoder.encode("a,b\n1,2\n")], "utf-8"],
    ["UTF-8 past ASCII", [...encoder.encode("café,naïve\n")], "utf-8"],
    ["UTF-8 with a byte order mark", [0xef, 0xbb, 0xbf, ...encoder.encode("a,b\n")], "utf-8"],
    ["a UTF-16 mark, low byte first", [0xff, 0xfe, 0x61, 0x00], "utf-16le"],
    ["a UTF-16 mark, high byte first", [0xfe, 0xff, 0x00, 0x61], "utf-16be"],
    ["UTF-16 with no mark, low byte first", [0x61, 0x00, 0x2c, 0x00, 0x62, 0x00], "utf-16le"],
    ["UTF-16 with no mark, high byte first", [0x00, 0x61, 0x00, 0x2c, 0x00, 0x62], "utf-16be"],
    ["Windows-1252", [...encoder.encode("caf"), E_ACUTE_1252, LF], "other"],
  ];

  for (const [title, bytes, encoding] of cases) {
    test(title, () => {
      expect(sniffEncoding(Uint8Array.from(bytes))).toBe(encoding);
    });
  }

  test("a character the head cuts in half is not held against it", () => {
    const whole = encoder.encode("café");
    expect(sniffEncoding(whole.subarray(0, whole.length - 1))).toBe("utf-8");
  });
});

test("peekFormat answers undefined for a file with no record, where openFormat refuses it", async () => {
  for (const text of ["", "\n\n", "\uFEFF"]) {
    expect(await peekFormat("f.csv", blobSource(new Blob([text])))).toBeUndefined();
    await expect(open("f.csv", text)).rejects.toThrow("f.csv: file is empty");
  }
  const f = await peekFormat("f.csv", blobSource(new Blob(["a,b\n"])));
  expect(f?.columns).toEqual(["a", "b"]);
});

test("a delimiter and an encoding each have a name a sentence can use", () => {
  expect([",", "\t", ";", "|", ":"].map(delimiterName)).toEqual([
    "comma",
    "tab",
    "semicolon",
    "pipe",
    "':'",
  ]);
  const encodings: Encoding[] = ["utf-8", "utf-16le", "utf-16be", "other"];
  expect(encodings.map(encodingName)).toEqual([
    "UTF-8",
    "UTF-16 little-endian",
    "UTF-16 big-endian",
    "neither UTF-8 nor UTF-16",
  ]);
});
