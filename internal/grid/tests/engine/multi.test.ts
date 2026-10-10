// Several files read as one through the engine: a ref of parts opens through
// the multi provider, and the join is indexed and paged like any file.

import { setImmediate as turn } from "node:timers/promises";

import { expect, test } from "vite-plus/test";

import { english } from "../../src/engine/index.ts";
import type { SourceRef } from "../../src/engine/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { blobProvider, multiProvider } from "../../src/store/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { PARTS, PART_FIXTURES, PART_NAMES, partBytes } from "../testdata/sales-q3-parts.ts";
import {
  FIXTURE,
  TINY,
  bytes,
  connect,
  indexed,
  multiProviders,
  openOne,
  sales,
  sheetRows,
  widened,
} from "./harness.ts";

/** What the three parts are called as one source. */
const NAME = "sales-q3";

/** How many rows are asked for at a time. */
const PAGE = 500;

/** How many rows a peek is compared over. */
const PEEKED = 5;

/** A save limit larger than any carried source here. */
const ROOMY = 1 << 20;

/** The fixture's three parts on disk, as one ref. */
const THREE: SourceRef = {
  name: NAME,
  parts: PART_FIXTURES.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } })),
  header: "first",
};

test("the engine opens three parts as the one table the whole file is", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const src = await openOne(engine, THREE);
    await indexed(src);
    expect(src.opened.name).toBe(NAME);
    expect(src.progress).toMatchObject({ rows: ROWS, readable: ROWS, complete: true });
    expect(src.opened.columns).toEqual(sales.columns);
    // Every row, across both part boundaries.
    for (let first = 0; first < ROWS; first += PAGE) {
      const { rows } = await src.rows(first, PAGE);
      expect(widened(rows), `rows from ${first}`).toEqual(sheetRows(sales, first, PAGE, "raw"));
    }
  } finally {
    done();
  }
});

test("a part on disk and parts dropped in open as one source", async () => {
  const { engine, done } = connect(TINY, multiProviders());
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
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const peeked = await engine.peek(THREE);
    expect(peeked.header).toEqual(sales.columns.map((c) => c.header));
    expect(widened(peeked.rows.slice(0, PEEKED))).toEqual(sheetRows(sales, 0, PEEKED, "raw"));
  } finally {
    done();
  }
});

// Relinking to or from a source of parts is refused. Saving one is covered in
// multisave.test.ts.
test("a source of parts has no link, and is not re-pointed yet", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const whole = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    const three = await openOne(engine, THREE);
    await indexed(three);
    expect(three.opened.link).toBeUndefined();

    await expect(engine.relink(whole, THREE)).rejects.toThrow(
      `${NAME} is ${PARTS} files read as one, and sales-q3.csv cannot be pointed at one yet`,
    );
    await expect(engine.relink(three, { name: "sales-q3.csv", path: FIXTURE })).rejects.toThrow(
      `${NAME} is ${PARTS} files read as one, and sales-q3.csv is one file`,
    );

    // Both sources are unchanged.
    expect(widened((await three.rows(0, PAGE)).rows)).toEqual(sheetRows(sales, 0, PAGE, "raw"));
    await engine.remove(three);
    expect(
      (await engine.save({ source: whole.id, cells: [], at: "" }, ROOMY)).length,
    ).toBeGreaterThan(0);
  } finally {
    done();
  }
});

test("a ref of parts called .uno opens as a source", async () => {
  const { engine, done } = connect(TINY, multiProviders());
  try {
    const src = await openOne(engine, { ...THREE, name: "sales-q3.uno" });
    await indexed(src);
    expect(src.progress.rows).toBe(ROWS);
  } finally {
    done();
  }
});

// ------------------------------------------------------------ closing

/** The one byte an open reads at a part's end to check for a newline. */
const MEASURED = 1;

/**
 * watched is the disk provider with every open and close recorded. The read
 * that reaches the end of the first part is held until `release` is called.
 */
function watched(): {
  provider: Provider;
  /** Every file opened, in order. */
  opened: string[];
  closed: string[];
  /** Resolves once the read at the boundary is held. */
  reached: Promise<void>;
  /** Resolves once PARTS files have been closed. */
  shut: Promise<void>;
  release: () => void;
} {
  const disk = diskProvider();
  const opened: string[] = [];
  const closed: string[] = [];
  let reach: () => void = () => {};
  let shutNow: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const shut = new Promise<void>((resolve) => {
    shutNow = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    provider: {
      ...disk,
      files: {
        label: disk.files.label,
        handles: (ref) => disk.files.handles(ref),
        async open(ref) {
          // Recorded before the disk answers.
          opened.push(ref.name);
          const source = await disk.files.open(ref);
          return {
            size: source.size,
            version: source.version,
            async read(offset, length) {
              const read = await source.read(offset, length);
              const boundary =
                ref.name === PART_NAMES[0] && length > MEASURED && offset + length === source.size;
              if (boundary) {
                reach();
                await gate;
              }
              return read;
            },
            async close() {
              await source.close();
              closed.push(ref.name);
              if (closed.length === PARTS) shutNow();
            },
          };
        },
      },
    },
    opened,
    closed,
    reached,
    shut,
    release,
  };
}

// The source is removed while a read spanning two parts is held. Every part
// must be closed afterwards.
test("a source of parts removed while it is indexing leaves no part open", async () => {
  const disk = watched();
  const single = [disk.provider, blobProvider()];
  const { engine, done } = connect(TINY, [...single, multiProvider(single)]);
  const errors: string[] = [];
  engine.onError = (said) => errors.push(english(said));
  try {
    // Opened as a blob, so every disk open is a part.
    const whole = await openOne(engine, { name: "sales-q3.csv", blob: new Blob([bytes]) });
    const three = await openOne(engine, THREE);
    await disk.reached;
    expect(three.progress.complete).toBe(false);

    await engine.remove(three);
    disk.release();
    // Let the released read and anything it triggers run.
    await turn();
    // Any error from the engine arrives before this reply.
    await whole.rows(0, PEEKED);

    expect(disk.opened.toSorted(), "no part is opened again").toEqual(PART_NAMES);
    expect(disk.closed.toSorted(), "and every part opened is closed").toEqual(PART_NAMES);
    expect(errors, "a source that was removed has nothing to report").toEqual([]);
  } finally {
    done();
  }
});

test("an engine closed while a source of parts is indexing leaves no part open", async () => {
  const disk = watched();
  const single = [disk.provider, blobProvider()];
  const { engine, done } = connect(TINY, [...single, multiProvider(single)]);
  try {
    const three = await openOne(engine, THREE);
    await disk.reached;
    expect(three.progress.complete).toBe(false);
  } finally {
    done();
  }
  await disk.shut;
  disk.release();
  await turn();

  expect(disk.opened.toSorted(), "no part is opened again").toEqual(PART_NAMES);
  expect(disk.closed.toSorted(), "and every part opened is closed").toEqual(PART_NAMES);
});
