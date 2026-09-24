// What a file holds, before anything is added to the workspace.
//
// A peek is the answer to a selection in a panel: somebody clicking down a
// folder of four hundred objects asks the same question of each one, so a
// 30 GB export and a 30 KB one have to cost the same. That is the whole design,
// and it is why this module is two halves rather than one function.
//
// `readHead` is the half that touches a handler: open once, read the front, and
// close, whatever the file turns out to be. Everything checked about it here is
// about cost -- how many reads went out, how long they were, and that the file
// was let go of afterwards -- because that is the only promise the front of a
// file can break.
//
// `peekHead` is the half that is bytes and nothing else: detect the format the
// way an open would, name the columns, and hand back the rows the window
// happened to hold. It is handed a head rather than a file so that every awkward
// shape -- a row cut in two, a quoted field cut in two, a header with nothing
// under it -- is a string in this file rather than a fixture on a disk.

import { expect, test } from "vite-plus/test";

import { PEEK_BYTES, PEEK_ROWS, peek, peekHead, readHead } from "../../src/engine/peek.ts";
import type { Head } from "../../src/engine/peek.ts";
import { headerOf, readAll } from "../../src/ingest/index.ts";
import { blobFiles } from "../../src/store/index.ts";
import type { ByteSource, FileHandler, FileRef } from "../../src/store/index.ts";
import { localFiles } from "../../src/store/node.ts";
import { FIXTURE, bytes } from "./harness.ts";

/**
 * The size of tests/testdata/generated/sales-q3-50m.csv, the file this task's
 * check names. It is 2.5 GB and too large to commit, so what stands in for it
 * here is a source that says it is that big and holds nothing -- which is the
 * better test of the two anyway, because a read it was never asked for cannot
 * hide in it. The real 2.5 GB file is read where a machine has one.
 */
const HUGE = 2_500_118_439;

const encoder = new TextEncoder();

/** A head built out of text, cut to `limit` bytes the way a read of one would be. */
function head(text: string, limit = PEEK_BYTES): Head {
  const all = encoder.encode(text);
  return { bytes: all.subarray(0, Math.min(limit, all.length)), size: all.length };
}

/** What sales-q3.csv holds, read the way `read` reads it, to compare a peek with. */
const records = readAll(new TextDecoder().decode(bytes), ",");
const HEADER = headerOf(records[0]!);
const FIRST_ROWS = records.slice(1, PEEK_ROWS + 1).map((r) => HEADER.map((_, i) => r[i] ?? ""));

/** One read a source was asked for. */
interface Read {
  offset: number;
  length: number;
}

/** A handler watching what was asked of it, and whether the file was let go of. */
interface Watched {
  files: FileHandler;
  reads: Read[];
  closed: () => number;
}

/**
 * virtual is a file of `size` bytes that nothing holds: byte i is the fixture's
 * byte i % bytes.length, so the front of it is the front of sales-q3.csv and a
 * 2.5 GB file costs what the 64 KB answer costs.
 *
 * It is a handler and not a fixture because the promise under test is a cost.
 * Being the file is the only way to watch a read that should not have happened.
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

/** A file that opens and will not read: the descriptor still has to be closed. */
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

// The check this task exists for, minus the 2.5 GB on disk. One read, 64 KB
// long, from the front, and the file closed after it.
test("the front of a 2.5 GB file is one read of 64 KB, and the file is closed", async () => {
  const f = virtual(HUGE);

  const front = await readHead([f.files], BIG);

  expect(f.reads).toEqual([{ offset: 0, length: PEEK_BYTES }]);
  expect(front.bytes.length).toBe(PEEK_BYTES);
  expect(f.closed()).toBe(1);
  // The size is the file's and not the window's: it is what says whether the
  // window is all of it, which is what the rows half needs to know.
  expect(front.size).toBe(HUGE);
});

// A peek must cost the same whatever it lands on: that is the reason there is
// a window at all, and the thing a panel is built on top of.
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

// Asking a bucket for bytes past the end of an object is a 416 on servers that
// are stricter than S3, and asking for them is pointless everywhere else.
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

// A descriptor left open because the read threw is a leak per click, and a
// person clicking down a folder of four hundred objects does the clicking.
test("the file is closed even when the read fails", async () => {
  const f = unreadable();

  await expect(readHead([f.files], BIG)).rejects.toThrow("the disk went away");

  expect(f.reads).toHaveLength(1);
  expect(f.closed()).toBe(1);
});

// The refusal is claim.ts's, the same sentence an open gets, because it is the
// same question: a peek opens through a handler and nothing else.
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
  // The same sentence an opened source carries, so the panel and the tab say
  // the same thing about the same file.
  expect(peeked.label).toBe("UTF-8 · delimiter ','");
});

test("a peek of bytes in hand needs no path", async () => {
  const peeked = await peek([blobFiles()], { name: "sales-q3.csv", blob: new Blob([bytes]) });
  expect(peeked.header).toEqual(HEADER);
  expect(peeked.rows).toEqual(FIRST_ROWS);
});

// The window ends where the bytes ran out and not where a row did, so the last
// record in it is usually half of one. Drawing half a row would put a cell on
// screen holding a value the file does not have in it.
test("a row the window cut in half is left out", async () => {
  const text = "a,b\n1,2\n3,4\n5,6\n";

  expect((await peekHead("cut.csv", head(text, 14))).rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
  // One byte later is the same answer: the row is whole only once the byte
  // after it has been seen.
  expect((await peekHead("cut.csv", head(text, 15))).rows).toEqual([
    ["1", "2"],
    ["3", "4"],
  ]);
});

// A cut inside quotes is the case a line-counting peek gets wrong: the bytes
// look like a row that ends, and the file says it does not.
test("a quoted field the window cut in half is left out", async () => {
  const text = 'a,b\n1,"x,y"\n2,"z,w"\n';
  const peeked = await peekHead("quoted.csv", head(text, 16));
  expect(peeked.rows).toEqual([["1", "x,y"]]);
});

// Nothing was cut, because there is nothing after it: the last row of a file
// that ends without a newline is a whole row.
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

// The grid draws a row as wide as its header, so a peek that did anything else
// would be showing a different table from the one an open gives.
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

// The same sentence `read` gives a whole empty file. A peek that answered with
// no columns would be drawn as a file that has none, which is the quieter lie.
test("an empty file is refused by name", async () => {
  await expect(peekHead("empty.csv", head(""))).rejects.toThrow("empty.csv: file is empty");
});

test("the delimiter comes from the name for a .tsv and from the bytes otherwise", async () => {
  const tsv = await peekHead("q3.tsv", head("a\tb\n1\t2\n"));
  expect(tsv.label).toBe("UTF-8 · tab-separated");
  expect(tsv.header).toEqual(["a", "b"]);

  const semis = await peekHead("q3.csv", head("a;b\n1;2\n3;4\n"));
  expect(semis.label).toBe("UTF-8 · delimiter ';'");
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

// JSON is not a format uno reads yet, and a peek says so in the words an open
// says it in rather than showing an empty table.
test("a format uno cannot read is refused by name", async () => {
  await expect(peekHead("events.json", head("[]"))).rejects.toThrow(
    "events.json: JSON is not supported yet",
  );
});

// A header longer than the window is a real file -- a few thousand columns, or
// a name with a newline in it -- and an open grows its read until it has the
// whole header. A peek cannot: growing is a second request, and one request is
// the promise. So it answers with the names the window did hold and no rows,
// rather than paying twice or waiting.
test("a header the window did not reach the end of peeks as no rows", async () => {
  const wide = `${Array.from({ length: 200 }, (_, i) => `column_${i}`).join(",")}\n1,2,3\n`;

  const peeked = await peekHead("wide.csv", head(wide, 64));

  expect(peeked.rows).toEqual([]);
  expect(peeked.header[0]).toBe("column_0");
  expect(peeked.header.length).toBeLessThan(200);
});
