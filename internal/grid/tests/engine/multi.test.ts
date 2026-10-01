// The engine over several files read as one: a ref of parts opens like any
// other ref, through the handler a platform lists for it, and the engine
// indexes and pages the join the way it does any file.

import { expect, test } from "vite-plus/test";

import type { SourceRef } from "../../src/engine/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { PARTS, PART_FIXTURES, PART_NAMES, partBytes } from "../testdata/sales-q3-parts.ts";
import { FIXTURE, TINY, connect, indexed, openOne, sales, sheetRows, widened } from "./harness.ts";

/** What the three parts are called as one source. */
const NAME = "sales-q3";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** How many rows a peek is compared over. */
const PEEKED = 5;

/** More than any source here would need a save to carry. */
const ROOMY = 1 << 20;

/** The fixture's three parts on disk, as one ref. */
const THREE: SourceRef = {
  name: NAME,
  parts: PART_FIXTURES.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } })),
  header: "first",
};

/** The places a part can be here, and over them several read as one. */
function providers(): Provider[] {
  const single = [diskProvider(), blobProvider()];
  return [...single, multiProvider(single)];
}

test("the engine opens three parts as the one table the whole file is", async () => {
  const { engine, done } = connect(TINY, providers());
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

// A part is whatever one file can be, and the ref crosses the channel with a
// Blob in it as it does with a path.
test("a part on disk and parts dropped in open as one source", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, {
      name: NAME,
      parts: PART_NAMES.map((name, i) =>
        i === 0
          ? { ref: { name, path: PART_FIXTURES[i]! } }
          : { ref: { name, blob: new Blob([partBytes[i]!.slice()]) } },
      ),
      header: "first",
    });
    await indexed(src);
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    const last = ROWS - PAGE;
    expect(widened((await src.rows(last, PAGE)).rows)).toEqual(sheetRows(sales, last, PAGE, "raw"));
  } finally {
    done();
  }
});

// The task's own sentence: the platform decides, and a build without the
// handler says which source it cannot open and what it is missing.
test("an engine that does not list multiFiles refuses a ref of parts by name", async () => {
  const { engine, done } = connect(TINY);
  try {
    await expect(engine.open(THREE)).rejects.toThrow(
      "sales-q3: nothing here opens several files as one · this build reads local files, dropped files",
    );
    await expect(engine.peek(THREE)).rejects.toThrow(
      "sales-q3: nothing here opens several files as one · this build reads local files, dropped files",
    );
  } finally {
    done();
  }
});

test("a part in a kind of place the engine does not read is refused, naming the part", async () => {
  const single = [diskProvider()];
  const { engine, done } = connect(TINY, [...single, multiProvider(single)]);
  try {
    const parts = THREE.parts.with(1, {
      ref: { name: PART_NAMES[1]!, path: "s3://acme/part.csv" },
    });
    await expect(engine.open({ ...THREE, parts })).rejects.toThrow(
      `${PART_NAMES[1]} (part 2 of ${PARTS}): s3://acme/part.csv: nothing here opens it · this build reads local files`,
    );
  } finally {
    done();
  }
});

test("a peek of parts shows the top of the join", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const peeked = await engine.peek(THREE);
    expect(peeked.header).toEqual(sales.columns.map((c) => c.header));
    expect(widened(peeked.rows.slice(0, PEEKED))).toEqual(sheetRows(sales, 0, PEEKED, "raw"));
  } finally {
    done();
  }
});

// What a source of parts does not do yet, each refused in words and with the
// source left as it was.
test("a source of parts has no link, and is not saved or re-pointed yet", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const whole = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    const three = await openOne(engine, THREE);
    await indexed(three);
    expect(three.opened.link).toBeUndefined();

    await expect(engine.save({ source: three.id, cells: [], at: "" }, ROOMY)).rejects.toThrow(
      `${NAME} is ${PARTS} files read as one, and a workspace cannot save one yet`,
    );
    await expect(engine.relink(whole, THREE)).rejects.toThrow(
      `${NAME} is ${PARTS} files read as one, and sales-q3.csv cannot be pointed at one yet`,
    );
    await expect(engine.relink(three, { name: "sales-q3.csv", path: FIXTURE })).rejects.toThrow(
      `${NAME} is ${PARTS} files read as one, and cannot be pointed at another file yet`,
    );

    // Both are still what they were, and without the parts the rest saves.
    expect(widened((await three.rows(0, PAGE)).rows)).toEqual(sheetRows(sales, 0, PAGE, "raw"));
    await engine.remove(three);
    expect(
      (await engine.save({ source: whole.id, cells: [], at: "" }, ROOMY)).length,
    ).toBeGreaterThan(0);
  } finally {
    done();
  }
});

// Parts named like a workspace are still parts.
test("a ref of parts called .uno opens as a source", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, { ...THREE, name: "sales-q3.uno" });
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});
