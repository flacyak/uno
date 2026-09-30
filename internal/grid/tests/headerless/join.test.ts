// openMulti tests with header mode "none". Every part is read from its first
// line. The
// join still drops a later part's byte order mark, adds a missing final
// newline, and refuses parts whose first row or delimiter differs from the
// first part's.

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { openFormat } from "../../src/ingest/index.ts";
import type { ByteSource } from "../../src/store/index.ts";
import { DisagreementError, openMulti } from "../../src/store/multi.ts";
import type { MultiSource, Part } from "../../src/store/multi.ts";
import { localFiles } from "../../src/store/node.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { PART_ROWS } from "../testdata/sales-q3-parts.ts";
import { BOM, COLUMNS, NAMES, allRows, marked, onDisk, rowsOnly } from "./parts.ts";

const HANDLERS = [localFiles()];
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Reads every byte of a source. */
const readAll = (src: ByteSource): Promise<Uint8Array> => src.read(0, src.size);

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** Writes `files` to a temp dir and returns them as parts of one source. */
async function parts(files: readonly Uint8Array[]): Promise<Part[]> {
  const { dir, paths } = await onDisk(files);
  dirs.push(dir);
  return paths.map((path, i) => ({ ref: { name: NAMES[i]!, path } }));
}

/** Opens `files` as one headerless source, runs `fn` on it, and closes it. */
async function joined<T>(files: readonly Uint8Array[], fn: (src: MultiSource) => Promise<T>) {
  const src = await openMulti(HANDLERS, await parts(files), "none");
  try {
    return await fn(src);
  } finally {
    await src.close();
  }
}

describe("headerless parts joined", () => {
  let three: Part[];
  beforeAll(async () => {
    three = await parts(rowsOnly);
  });

  test("are every byte of every part, with nothing skipped", async () => {
    const src = await openMulti(HANDLERS, three, "none");
    try {
      expect(src.size).toBe(allRows.length);
      expect(await readAll(src)).toEqual(allRows);
      expect(src.extents.map((e) => e.skip)).toEqual([0, 0, 0]);
    } finally {
      await src.close();
    }
  });

  test("read as one headerless file: numbered columns, and a row for every line", async () => {
    const src = await openMulti(HANDLERS, three, "none");
    try {
      const format = await openFormat("sales-q3-rows", src, "none");
      expect(format.columns).toEqual(COLUMNS);
      expect(format.dataStart).toBe(0);

      const starts: number[] = [];
      const whole = await readAll(src);
      format.scanner((offset) => starts.push(offset)).push(whole, 0);
      expect(starts).toHaveLength(ROWS);

      // The first row of each part maps back to that part.
      for (let part = 0; part < three.length; part++) {
        expect(src.map.partAt(starts[part * PART_ROWS]!), `part ${part + 1}`).toBe(part);
      }
    } finally {
      await src.close();
    }
  });
});

describe("what the join still mends with no header", () => {
  test("a later part's byte order mark is left out, and the first part's is kept", async () => {
    const a = encode("1,2\n");
    const b = encode("3,4\n");
    await joined([marked(a), marked(b)], async (src) => {
      expect(await readAll(src)).toEqual(marked(encode("1,2\n3,4\n")));
      expect(src.extents.map((e) => e.skip)).toEqual([0, BOM.length]);

      const format = await openFormat("rows", src, "none");
      expect(format.dataStart).toBe(BOM.length);
      expect(format.decode((await readAll(src)).subarray(format.dataStart))).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    });
  });

  test("a part with no newline after its last row is given one", async () => {
    await joined([encode("1,2\n3,4"), encode("5,6\n")], async (src) => {
      expect(new TextDecoder().decode(await readAll(src))).toBe("1,2\n3,4\n5,6\n");
    });
  });
});

describe("headerless parts that do not agree", () => {
  test("a part whose first row has another number of cells is refused, naming it", async () => {
    const opening = joined([encode("1,2,3\n"), encode("4,5\n")], () => Promise.resolve());
    await expect(opening).rejects.toThrow(DisagreementError);
    await expect(opening).rejects.toThrow(
      `${NAMES[1]} (part 2 of 2): its first row has 2 columns and ${NAMES[0]}'s has 3`,
    );
  });

  test("a part with another delimiter is refused, naming it", async () => {
    const opening = joined([encode("1,2\n3,4\n"), encode("5;6\n7;8\n")], () => Promise.resolve());
    await expect(opening).rejects.toThrow(
      `${NAMES[1]} (part 2 of 2): it is semicolon-separated and ${NAMES[0]} is comma-separated`,
    );
  });

  test("parts whose first rows hold different values agree: a row is not a header", async () => {
    await joined([encode("north,1\n"), encode("south,2\n")], async (src) => {
      expect(new TextDecoder().decode(await readAll(src))).toBe("north,1\nsouth,2\n");
    });
  });
});
