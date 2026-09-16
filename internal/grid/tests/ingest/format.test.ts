import { describe, expect, test } from "vite-plus/test";

import { openFormat, read } from "../../src/ingest/index.ts";
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
