import { describe, expect, test } from "vite-plus/test";

import { read, readAll } from "../../src/ingest/index.ts";

describe("read sniffs the delimiter from the bytes", () => {
  const cases: Array<[string, string, string]> = [
    ["comma", "a,b,c\n1,2,3\n", "UTF-8 · delimiter ','"],
    ["semicolon", "a;b;c\n1;2;3\n", "UTF-8 · delimiter ';'"],
    ["pipe", "a|b|c\n1|2|3\n", "UTF-8 · delimiter '|'"],
    ["tab in a .csv", "a\tb\tc\n1\t2\t3\n", "UTF-8 · tab-separated"],
  ];

  for (const [name, body, wantSource] of cases) {
    test(name, () => {
      const s = read("f.csv", body);
      expect(s.cols()).toBe(3);
      expect(s.source).toBe(wantSource);
    });
  }
});

// The extension decides before the bytes do, so a single-column TSV is not
// mistaken for a comma-delimited file with one field.
test("read trusts the .tsv extension", () => {
  expect(read("f.tsv", "a\tb\n1\t2\n").cols()).toBe(2);
});

// A separator inside a quoted field is data, not structure.
test("sniff ignores delimiters inside quotes", () => {
  const s = read("f.csv", 'name,role\n"Okafor, Ada",lead\n"Iyer, Ben",eng\n');
  expect(s.cols()).toBe(2);
  expect(s.raw(0, 0)).toBe("Okafor, Ada");
});

test("read pads ragged rows rather than rejecting the file", () => {
  const s = read("f.csv", "a,b,c\n1,2,3\n4\n5,6,7\n");
  expect(s.rows()).toBe(3);
  expect(s.raw(1, 2)).toBe("");
});

test("read handles CRLF", () => {
  expect(read("f.csv", "a,b\r\n1,2\r\n").raw(0, 1)).toBe("2");
});

describe("read names the file in every error", () => {
  const cases: Array<[string, string, string, string]> = [
    ["empty file", "empty.csv", "", "file is empty"],
    ["json", "data.json", "[]", "not supported yet"],
  ];

  for (const [name, file, body, want] of cases) {
    test(name, () => {
      let thrown: Error | undefined;
      try {
        read(file, body);
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain(want);
      // An error dialog that does not name the file is useless in a twelve-file
      // drop.
      expect(thrown!.message).toContain(file);
    });
  }
});

// A header-only file is a valid sheet with no rows, not an error.
test("read accepts a header with no rows", () => {
  const s = read("f.csv", "a,b,c\n");
  expect(s.rows()).toBe(0);
  expect(s.cols()).toBe(3);
});

// The lazy-quote rules are the reason this reader is hand-written rather than
// taken from npm: every one of these opens in Go, and a stricter reader would
// reject the file instead.
describe("the csv reader follows Go's rules", () => {
  const cases: Array<[string, string, string[][]]> = [
    ["doubled quotes are one quote", 'a\n"say ""hi"""\n', [["a"], ['say "hi"']]],
    [
      "a bare quote in an unquoted field is data",
      'a,b\n12",3\n',
      [
        ["a", "b"],
        ['12"', "3"],
      ],
    ],
    ["a bare quote inside a quoted field is data", 'a\n"12"3"\n', [["a"], ['12"3']]],
    [
      "a newline inside a quoted field",
      'a,b\n"one\ntwo",3\n',
      [
        ["a", "b"],
        ["one\ntwo", "3"],
      ],
    ],
    ["CRLF inside a quoted field becomes LF", 'a\n"one\r\ntwo"\n', [["a"], ["one\ntwo"]]],
    [
      "a blank line is spacing, not a row",
      "a,b\n1,2\n\n3,4\n",
      [
        ["a", "b"],
        ["1", "2"],
        ["3", "4"],
      ],
    ],
    [
      "no trailing newline",
      "a,b\n1,2",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    [
      "a trailing CR before end of file is dropped",
      "a,b\n1,2\r",
      [
        ["a", "b"],
        ["1", "2"],
      ],
    ],
    ["an unterminated quoted field still reads", 'a\n"one\n', [["a"], ["one\n"]]],
    ["empty fields are kept", "a,,c\n", [["a", "", "c"]]],
  ];

  for (const [name, body, want] of cases) {
    test(name, () => {
      expect(readAll(body, ",")).toEqual(want);
    });
  }
});
