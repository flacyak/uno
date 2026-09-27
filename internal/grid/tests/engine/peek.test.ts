// The front of a file, read once and let go of.
//
// A peek is the answer to a selection in a panel: somebody clicking down a
// folder of four hundred objects asks the same question of each one, so a
// 30 GB export and a 30 KB one have to cost the same. That is the whole design,
// and `readHead` is the half of it that touches a handler -- open once, read
// the front, close, whatever the file turns out to be.
//
// Everything checked here is about cost: how many reads went out, how long they
// were, and that the file was let go of afterwards. They are the only promises
// the front of a file can break, and every one of them is invisible from the
// answer -- a peek that read the whole object to find its rows would return the
// same header.

import { expect, test } from "vite-plus/test";

import { PEEK_BYTES, readHead } from "../../src/engine/peek.ts";
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
