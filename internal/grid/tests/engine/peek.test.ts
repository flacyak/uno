// `readHead` and `peekHead`, the two halves of a peek.
//
// `readHead` opens a file through a handler, reads its front, and closes it.
// The checks here count reads and closes.
//
// `peekHead` parses a head: it detects the format, names the columns, and
// returns the whole rows in the window. The heads are strings in this file.

import { expect, test } from "vite-plus/test";

import { PEEK_BYTES, PEEK_ROWS, peek, peekHead, readHead } from "../../src/engine/peek.ts";
import type { Head } from "../../src/engine/peek.ts";
import { headerOf, readAll } from "../../src/ingest/index.ts";
import { blobFiles } from "../../src/store/index.ts";
import type { ByteSource, FileHandler, FileRef } from "../../src/store/index.ts";
import { localFiles } from "../../src/store/node.ts";
import { FIXTURE, bytes, saidIn } from "./harness.ts";

/** The size of a 2.5 GB file. A virtual source stands in for it here. */
const HUGE = 2_500_118_439;

const encoder = new TextEncoder();

/** A head of `text`, cut to `limit` bytes, with the full size. */
function head(text: string, limit = PEEK_BYTES): Head {
  const all = encoder.encode(text);
  return { bytes: all.subarray(0, Math.min(limit, all.length)), size: all.length };
}

/** The fixture's records, to compare a peek with. */
const records = readAll(new TextDecoder().decode(bytes), ",");
const HEADER = headerOf(records[0]!);
const FIRST_ROWS = records.slice(1, PEEK_ROWS + 1).map((r) => HEADER.map((_, i) => r[i] ?? ""));

/** One read a source was asked for. */
interface Read {
  offset: number;
  length: number;
}

/** A handler that records its reads and closes. */
interface Watched {
  files: FileHandler;
  reads: Read[];
  closed: () => number;
}

/**
 * virtual is a handler for a file of `size` bytes, where byte i is the
 * fixture's byte i % bytes.length. Reads and closes are recorded.
 */
function virtual(size: number): Watched {
  const reads: Read[] = [];
  let closed = 0;

  const source: ByteSource = {
    size,
    read: (offset, length) => {
      reads.push({ offset, length });
      const want = Math.max(0, Math.min(length, size - offset));
      const out = new Uint8Array(want);
      for (let i = 0; i < want; i++) out[i] = bytes[(offset + i) % bytes.length]!;
      return Promise.resolve(out);
    },
    close: () => {
      closed++;
      return Promise.resolve();
    },
  };

  return {
    files: {
      label: "a file of any size",
      handles: (ref: FileRef) => "path" in ref && ref.path.startsWith("virtual://"),
      open: () => Promise.resolve(source),
    },
    reads,
    closed: () => closed,
  };
}

/** A handler whose file opens but rejects every read. */
function unreadable(): Watched {
  const reads: Read[] = [];
  let closed = 0;
  return {
    files: {
      label: "a file that will not read",
      handles: () => true,
      open: () =>
        Promise.resolve({
          size: HUGE,
          read: (offset: number, length: number) => {
            reads.push({ offset, length });
            return Promise.reject(new Error("the disk went away"));
          },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        }),
    },
    reads,
    closed: () => closed,
  };
}

const BIG: FileRef = { name: "sales-q3-50m.csv", path: "virtual://sales-q3-50m.csv" };

// ------------------------------------------------------------ the front of a file

test("the front of a 2.5 GB file is one read of 64 KB, and the file is closed", async () => {
  const f = virtual(HUGE);

  const front = await readHead([f.files], BIG);

  expect(f.reads).toEqual([{ offset: 0, length: PEEK_BYTES }]);
  expect(front.bytes.length).toBe(PEEK_BYTES);
  expect(f.closed()).toBe(1);
  // `size` is the whole file's size.
  expect(front.size).toBe(HUGE);
});

test("a 30 KB file and a 2.5 GB one are read the same number of times", async () => {
  const small = virtual(30 << 10);
  const big = virtual(HUGE);

  await readHead([small.files], BIG);
  await readHead([big.files], BIG);

  expect(small.reads).toHaveLength(1);
  expect(big.reads).toHaveLength(1);
  expect(small.closed()).toBe(1);
  expect(big.closed()).toBe(1);
});

test("a file smaller than the window is asked for only as far as it goes", async () => {
  const f = virtual(1024);

  const front = await readHead([f.files], BIG);

  expect(f.reads).toEqual([{ offset: 0, length: 1024 }]);
  expect(front.bytes.length).toBe(1024);
  expect(front.size).toBe(1024);
});

test("the window is the caller's, and the whole file is read when it fits", async () => {
  const front = await readHead([localFiles()], { name: "sales-q3.csv", path: FIXTURE }, 4096);
  expect(front.bytes).toEqual(bytes.subarray(0, 4096));
  expect(front.size).toBe(bytes.length);

  const whole = await readHead([localFiles()], { name: "sales-q3.csv", path: FIXTURE });
  expect(whole.bytes.length).toBe(PEEK_BYTES);
  expect(whole.size).toBe(bytes.length);
});

test("the file is closed even when the read fails", async () => {
  const f = unreadable();

  await expect(readHead([f.files], BIG)).rejects.toThrow("the disk went away");

  expect(f.reads).toHaveLength(1);
  expect(f.closed()).toBe(1);
});

// The refusal is the same sentence an open gets.
test("a ref nothing opens is refused by name", async () => {
  await expect(
    readHead([localFiles()], { name: "q3.csv", path: "s3://acme/exports/q3.csv" }),
  ).rejects.toThrow(
    "s3://acme/exports/q3.csv: nothing here opens it · this build reads local files",
  );
});

// ------------------------------------------------------------ the rows in it

test("the fixture peeks as its six headers and the twenty rows under them", async () => {
  const peeked = await peek([localFiles()], { name: "sales-q3.csv", path: FIXTURE });

  expect(peeked.header).toEqual(HEADER);
  expect(peeked.header).toHaveLength(6);
  expect(peeked.rows).toEqual(FIRST_ROWS);
  expect(peeked.rows).toHaveLength(PEEK_ROWS);
  // The same label an opened source carries.
  expect(saidIn(peeked.label)).toBe("UTF-8 · delimiter ','");
});

test("a peek of bytes in hand needs no path", async () => {
  const peeked = await peek([blobFiles()], { name: "sales-q3.csv", blob: new Blob([bytes]) });
  expect(peeked.header).toEqual(HEADER);
  expect(peeked.rows).toEqual(FIRST_ROWS);
});

// The last record in a window is usually cut, and a cut row is left out.
test("a row the window cut in half is left out", async () => {
  const text = "a,b\n1,2\n3,4\n5,6\n";

  expect((await peekHead("cut.csv", head(text, 14))).rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
  // A row counts as whole only once the byte after it is in the window.
  expect((await peekHead("cut.csv", head(text, 15))).rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("a quoted field the window cut in half is left out", async () => {
  const text = 'a,b\n1,"x,y"\n2,"z,w"\n';
  const peeked = await peekHead("quoted.csv", head(text, 16));
  expect(peeked.rows).toEqual([["1", "x,y"]]);
});

// When the window holds the whole file, the file's end closes the last row, so
// it is kept whole.
test("the last row of a file the window reached the end of is kept", async () => {
  expect((await peekHead("end.csv", head("a,b\n1,2\n3,4"))).rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("a file with fewer than twenty rows peeks as the rows it has", async () => {
  const peeked = await peekHead("short.csv", head("a,b\n1,2\n3,4\n"));
  expect(peeked.header).toEqual(["a", "b"]);
  expect(peeked.rows).toHaveLength(2);
});

test("twenty is the default, and a caller may ask for fewer", async () => {
  const text = `a,b\n${Array.from({ length: 50 }, (_, i) => `${i},x`).join("\n")}\n`;

  expect((await peekHead("many.csv", head(text))).rows).toHaveLength(PEEK_ROWS);
  expect((await peekHead("many.csv", head(text), 3)).rows).toEqual([
    ["0", "x"],
    ["1", "x"],
    ["2", "x"],
  ]);
});

test("a row is as wide as the header, short or long", async () => {
  const peeked = await peekHead("ragged.csv", head("a,b,c\n1\n2,3,4,5\n6,7,8\n"));
  expect(peeked.header).toEqual(["a", "b", "c"]);
  expect(peeked.rows).toEqual([
    ["1", "", ""],
    ["2", "3", "4"],
    ["6", "7", "8"],
  ]);
});

test("a header with nothing under it peeks as a header and no rows", async () => {
  for (const text of ["a,b,c\n", "a,b,c"]) {
    const peeked = await peekHead("headers.csv", head(text));
    expect(peeked.header).toEqual(["a", "b", "c"]);
    expect(peeked.rows).toEqual([]);
  }
});

// The same refusal `read` gives an empty file.
test("an empty file is refused by name", async () => {
  await expect(peekHead("empty.csv", head(""))).rejects.toThrow("empty.csv: file is empty");
});

test("the delimiter comes from the name for a .tsv and from the bytes otherwise", async () => {
  const tsv = await peekHead("q3.tsv", head("a\tb\n1\t2\n"));
  expect(saidIn(tsv.label)).toBe("UTF-8 · tab-separated");
  expect(tsv.header).toEqual(["a", "b"]);

  const semis = await peekHead("q3.csv", head("a;b\n1;2\n3;4\n"));
  expect(saidIn(semis.label)).toBe("UTF-8 · delimiter ';'");
  expect(semis.rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("a byte order mark is not part of the first column's name", async () => {
  const peeked = await peekHead("bom.csv", head("﻿a,b\n1,2\n"));
  expect(peeked.header).toEqual(["a", "b"]);
  expect(peeked.rows).toEqual([["1", "2"]]);
});

// The same refusal an open gives.
test("a format uno cannot read is refused by name", async () => {
  await expect(peekHead("events.json", head("[]"))).rejects.toThrow(
    "events.json: JSON is not supported yet",
  );
});

// A peek makes one read only. When the header runs past the window, the
// names the window held are returned, with an empty row list.
test("a header the window did not reach the end of peeks as no rows", async () => {
  const wide = `${Array.from({ length: 200 }, (_, i) => `column_${i}`).join(",")}\n1,2,3\n`;

  const peeked = await peekHead("wide.csv", head(wide, 64));

  expect(peeked.rows).toEqual([]);
  expect(peeked.header[0]).toBe("column_0");
  expect(peeked.header.length).toBeLessThan(200);
});
