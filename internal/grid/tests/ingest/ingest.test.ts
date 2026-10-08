import { describe, expect, test } from "vite-plus/test";

import { read, readAll, sniffDelimiter } from "../../src/ingest/index.ts";

/** How much of a file the sniff looks at. */
const PEEK = 64 << 10;

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

// A comma is the one candidate that lives inside fields too: as the decimal
// mark of a European export, and after a surname. Neither makes it the
// delimiter when another separator fits every line.
describe("sniff reads a comma inside fields as data", () => {
  const cases: Array<[string, string, string, string[]]> = [
    ["decimals between semicolons", "1,5;2,5;3,5\n4,5;5,5;6,5\n", ";", ["1,5", "2,5", "3,5"]],
    ["decimals and a name", "1,5;2,5;Müller\n3,5;4,5;Schmidt\n", ";", ["1,5", "2,5", "Müller"]],
    ["a price and a name", "1,50;Apfel\n2,00;Birne\n", ";", ["1,50", "Apfel"]],
    ["a surname and a name", "Müller, Hans;1,5\nSchmidt, Anna;2,5\n", ";", ["Müller, Hans", "1,5"]],
    ["a surname between tabs", "Smith, John\t42\nDoe, Jane\t37\n", "\t", ["Smith, John", "42"]],
    ["a surname between pipes", "Smith, John|42\nDoe, Jane|37\n", "|", ["Smith, John", "42"]],
  ];

  for (const [name, body, delimiter, firstRow] of cases) {
    test(name, () => {
      expect(sniffDelimiter(body)).toBe(delimiter);
      const s = read("f.csv", body, "none");
      expect(s.cols()).toBe(firstRow.length);
      expect(firstRow.map((_, c) => s.raw(0, c))).toEqual(firstRow);
    });
  }

  // Without another separator to fit, a comma between digits is a comma.
  test("integers between commas are still columns", () => {
    expect(sniffDelimiter("1,2,3\n4,5,6\n")).toBe(",");
  });
});

// A quoted cell can hold a line break. The sniff counts records, not lines, so
// the two halves of such a cell do not each get a field count of their own.
describe("sniff counts a quoted cell with a line break in it as one record", () => {
  test("in the first few records", () => {
    const s = read("f.csv", 'a;b\n1;"two\nlines"\n2;z\n');
    expect(s.cols()).toBe(2);
    expect(s.raw(0, 1)).toBe("two\nlines");
  });

  // The peek can end inside a quoted cell. What is open at the cut is not a
  // record yet, and nothing inside it is a delimiter.
  test("when the peek ends inside the cell", () => {
    const tail = "\n2,3\n4,5\n6,7\n8,9";
    const filler = "x".repeat(PEEK - tail.length);
    const text = `a;b\n1;"${filler}${tail}"\n5;6\n`;
    expect(sniffDelimiter(text)).toBe(";");
  });
});

test("read pads ragged rows rather than rejecting the file", () => {
  const s = read("f.csv", "a,b,c\n1,2,3\n4\n5,6,7\n");
  expect(s.rows()).toBe(3);
  expect(s.raw(1, 2)).toBe("");
});

test("read handles CRLF", () => {
  expect(read("f.csv", "a,b\r\n1,2\r\n").raw(0, 1)).toBe("2");
});

// The decoder strips a byte order mark from bytes. Text handed over as a string
// has to lose it too, or the first column is named "\uFEFFname" one way in and
// "name" the other.
test("read strips a byte order mark from a string as from bytes", () => {
  const body = "\uFEFFname,role\nAda,lead\n";
  const asString = read("f.csv", body);
  const asBytes = read("f.csv", new TextEncoder().encode(body));
  expect(asString.columns[0]!.header).toBe("name");
  expect(asString.columns.map((c) => c.header)).toEqual(asBytes.columns.map((c) => c.header));
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
