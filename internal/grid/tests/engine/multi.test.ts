// The engine over several files read as one. The engine reads a ByteSource and
// asks nothing more of it, so a handler that hands it the join is all it takes
// for the engine to index and page three files the way it does one.
//
// The handler here is a stand-in: a ref has no way to name several files yet,
// so it claims a path of its own and opens the parts the test built it with.

import { expect, test } from "vite-plus/test";

import type { SourceRef } from "../../src/engine/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobFiles, blobProvider } from "../../src/store/index.ts";
import { openMulti } from "../../src/store/multi.ts";
import type { Part } from "../../src/store/multi.ts";
import { diskProvider, localFiles } from "../../src/store/node.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { PART_FIXTURES, PART_NAMES, partBytes } from "../testdata/sales-q3-parts.ts";
import { TINY, connect, indexed, openOne, sales, sheetRows, widened } from "./harness.ts";

/** What the three parts are called as one source. */
const NAME = "sales-q3";

/** Where the stand-in says several files read as one are. */
const JOINED = "joined://";

/** The ref the stand-in claims. */
const THREE: SourceRef = { name: NAME, path: JOINED + NAME };

/** How many rows are asked for at a time. */
const PAGE = 500;

/** How many rows a peek is compared over. */
const PEEKED = 5;

/** The fixture's three parts on disk. */
const ON_DISK: Part[] = PART_FIXTURES.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } }));

/** The places a part can be here, and before them the stand-in that reads `parts` as one. */
function providers(parts: readonly Part[]): Provider[] {
  const single = [localFiles(), blobFiles()];
  const joined: Provider = {
    name: "joined",
    label: "several files as one",
    files: {
      label: "several files as one",
      handles: (ref) => "path" in ref && ref.path.startsWith(JOINED),
      open: () => openMulti(single, parts, "first"),
    },
  };
  return [joined, diskProvider(), blobProvider()];
}

test("the engine opens three parts as the one table the whole file is", async () => {
  const { engine, done } = connect(TINY, providers(ON_DISK));
  try {
    const src = await openOne(engine, THREE);
    await indexed(src);
    expect(src.opened.name).toBe(NAME);
    expect(src.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });
    expect(src.opened.columns).toEqual(sales.columns);
    // Every row, which crosses both boundaries, blocks and chunks alike.
    for (let first = 0; first < ROWS; first += PAGE) {
      const { rows } = await src.rows(first, PAGE);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, PAGE, "raw"));
    }
  } finally {
    done();
  }
});

// A part is whatever one file can be.
test("a part on disk and parts held as bytes open as one source", async () => {
  const parts: Part[] = PART_NAMES.map((name, i) =>
    i === 0
      ? { ref: { name, path: PART_FIXTURES[i]! } }
      : { ref: { name, blob: new Blob([partBytes[i]!.slice()]) } },
  );
  const { engine, done } = connect(TINY, providers(parts));
  try {
    const src = await openOne(engine, THREE);
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    const last = ROWS - PAGE;
    expect(widened((await src.rows(last, PAGE)).rows)).toEqual(sheetRows(sales, last, PAGE, "raw"));
  } finally {
    done();
  }
});

test("a peek of parts shows the top of the join", async () => {
  const { engine, done } = connect(TINY, providers(ON_DISK));
  try {
    const peeked = await engine.peek(THREE);
    expect(peeked.header).toEqual(sales.columns.map((c) => c.header));
    expect(widened(peeked.rows.slice(0, PEEKED))).toEqual(sheetRows(sales, 0, PEEKED, "raw"));
  } finally {
    done();
  }
});
