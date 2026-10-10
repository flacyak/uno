// Saving a source of several files read as one, and reopening the save. The
// save points at every part with what the join measured of it. A reopen
// places the parts from that record, opens a part when a read reaches it,
// and refuses a part that has drifted from the record.

import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { PARTS_VERSION, POINTED_VERSION, readContainer } from "../../src/document/index.ts";
import type { Document, HeldPart } from "../../src/document/index.ts";
import { english } from "../../src/engine/index.ts";
import type { Engine, SourceRef } from "../../src/engine/index.ts";
import type { Connection } from "../../src/library/index.ts";
import type { Provider } from "../../src/plugin/index.ts";
import { Op } from "../../src/sheet/index.ts";
import {
  blobProvider,
  bytesSource,
  connectionsIn,
  multiProvider,
  saveConnection,
} from "../../src/store/index.ts";
import type { HeaderMode } from "../../src/store/index.ts";
import { connectionSigning, diskProvider, nodeStore } from "../../src/store/node.ts";
import { connectionMeeting, s3Provider } from "../../src/store/s3.ts";
import { HOME_REGION } from "../store/regions.ts";
import { BUCKET, KEYS, bucket, keysOnly, etagOf, versionIdOf } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { ROWS, UNITS } from "../testdata/sales-q3.ts";
import {
  PARTS,
  PART_FIXTURES,
  PART_NAMES,
  PART_ROWS,
  partBytes,
} from "../testdata/sales-q3-parts.ts";
import { connect, everyRow, indexed, openOne, saidIn, sales, FIXTURE, TINY } from "./harness.ts";

/** What the three parts are called as one source. */
const NAME = "sales-q3";

/** What the workspace is saved as. */
const UNO = "q3.uno";

/** A save limit larger than any carried source here. */
const ROOMY = 1 << 20;

const LF = 0x0a;

/**
 * The header line's length, line ending included. The join skips it in every
 * part after the first.
 */
const HEADER_BYTES = partBytes[0]!.indexOf(LF) + 1;

/** A row in each part, and what its units are changed to. */
const EDITS = [
  { row: 1, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: ROWS - 1, now: "4" },
];

/** One edit in the first part only. */
const SHALLOW = EDITS.slice(0, 1);

/** The parts as one ref, each at `paths[i]`. */
function threeAt(paths: readonly string[], header: HeaderMode = "first"): SourceRef {
  return {
    name: NAME,
    parts: paths.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } })),
    header,
  };
}

/** Disk and blob providers plus `extra`, and a multi provider over them all. */
function providers(extra: Provider[] = []): Provider[] {
  const single = [diskProvider(), blobProvider(), ...extra];
  return [...single, multiProvider(single)];
}

/** A temp folder with a copy of each part. */
async function copied(): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "uno-multisave-"));
  const paths = PART_NAMES.map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => copyFile(PART_FIXTURES[i]!, path)));
  return { dir, paths };
}

/** A saved workspace and the rows its source showed. */
interface Saved {
  /** The .uno's bytes. */
  uno: Uint8Array;
  /** Every row as the source showed them at the save. */
  rows: string[][];
}

/** Opens `ref`, makes `edits` to its units, and saves the workspace to go at `at`. */
async function saved(
  engine: Engine,
  ref: SourceRef,
  edits: ReadonlyArray<{ row: number; now: string }>,
  at: string,
): Promise<Saved> {
  const src = await openOne(engine, ref);
  await indexed(src);
  engine.mode(true);
  for (const e of edits) await src.edit({ op: Op.Set, row: e.row, col: UNITS, now: e.now });
  const rows = await everyRow(src);
  return { uno: await engine.save({ source: src.id, cells: [], at }, ROOMY), rows };
}

/** Copies the parts to a folder, makes `edits`, and saves the .uno beside them. */
async function savedOnDisk(edits: ReadonlyArray<{ row: number; now: string }>) {
  const { dir, paths } = await copied();
  const file = join(dir, UNO);
  const { engine, done } = connect(TINY, providers());
  try {
    const made = await saved(engine, threeAt(paths), edits, file);
    await writeFile(file, made.uno);
    return { ...made, dir, paths, file };
  } finally {
    done();
  }
}

/** The one source of a saved workspace, as the .uno holds it. */
function held(uno: Uint8Array, at = ""): Document["sources"][number] {
  const doc = readContainer(UNO, uno, at);
  expect(doc.sources).toHaveLength(1);
  return doc.sources[0]!;
}

/** The HeldPart record expected for each part at `paths`. */
function measured(paths: readonly string[], versions: ReadonlyArray<string | undefined>) {
  return paths.map((path, i): HeldPart => ({
    name: PART_NAMES[i]!,
    path,
    bytes: partBytes[i]!.length,
    version: versions[i],
    skip: i === 0 ? 0 : HEADER_BYTES,
    unterminated: false,
  }));
}

const NO_VERSIONS = PART_NAMES.map(() => undefined);

// ------------------------------------------------------------ on a disk

test("three parts open as one, edited in each part, save as format 6 and reopen the same", async () => {
  const { uno, rows, paths, file } = await savedOnDisk(EDITS);

  // The save records every part and what the join measured.
  const doc = readContainer(UNO, uno, file);
  expect(doc.manifest.format).toBe(PARTS_VERSION);
  expect(doc.sources[0]).toMatchObject({
    id: NAME,
    name: NAME,
    parts: measured(paths, NO_VERSIONS),
    header: "first",
    rows: ROWS,
  });
  // Parts beside the .uno are written relative to it.
  expect(doc.manifest.sources[0]!.parts!.map((part) => part.path)).toEqual(PART_NAMES);
  expect(doc.log.map((l) => [l.edit.row, l.edit.now])).toEqual(EDITS.map((e) => [e.row, e.now]));

  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.opened.name).toBe(NAME);
    expect(src.opened.link, "several files have no one path to link to").toBeUndefined();
    expect(src.progress).toMatchObject({ rows: ROWS, complete: true });
    expect(src.opened.edits.map((e) => [e.row, e.now])).toEqual(EDITS.map((e) => [e.row, e.now]));

    // Every row and edit is as saved.
    expect(await everyRow(src)).toEqual(rows);
    for (const e of EDITS) {
      expect((await src.rows(e.row, 1)).rows[0]![UNITS]).toBe(e.now);
      expect((await src.rows(e.row - 1, 1)).rows[0]![UNITS]).toBe(sales.raw(e.row - 1, UNITS));
    }

    // A second save matches the first.
    const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
    expect(held(again, file)).toEqual(doc.sources[0]);
    expect(readContainer(UNO, again, file).log).toEqual(doc.log);
  } finally {
    done();
  }
});

test("a workspace is format 6 only while it holds several files as one", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const whole = await openOne(engine, { name: "sales-q3.csv", path: FIXTURE });
    await indexed(whole);
    const place = { source: whole.id, cells: [], at: "" };
    expect(readContainer(UNO, await engine.save(place, ROOMY)).manifest.format).toBe(
      POINTED_VERSION,
    );

    const three = await openOne(engine, threeAt(PART_FIXTURES));
    await indexed(three);
    expect(readContainer(UNO, await engine.save(place, ROOMY)).manifest.format).toBe(PARTS_VERSION);
    // Parts are only ever pointed at, so a limit of 0 still saves.
    expect((await engine.save(place, 0)).length).toBeGreaterThan(0);

    await engine.remove(three);
    expect(readContainer(UNO, await engine.save(place, ROOMY)).manifest.format).toBe(
      POINTED_VERSION,
    );
  } finally {
    done();
  }
});

test("a save is refused naming a part that is a dropped file", async () => {
  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, {
      name: NAME,
      parts: PART_NAMES.map((name, i) =>
        i === 1
          ? { ref: { name, blob: new Blob([partBytes[i]!.slice()]) } }
          : { ref: { name, path: PART_FIXTURES[i]! } },
      ),
      header: "first",
    });
    await indexed(src);
    await expect(engine.save({ source: src.id, cells: [], at: "" }, ROOMY)).rejects.toThrow(
      `${NAME}: ${PART_NAMES[1]} (part 2 of ${PARTS}) is a dropped file with no path, and a workspace points at each part of several files read as one`,
    );
    // The source is still what it was.
    expect((await src.rows(PART_ROWS, 1)).rows[0]![UNITS]).toBe(sales.raw(PART_ROWS, UNITS));
  } finally {
    done();
  }
});

// The header mode is saved, and the row count is the same on reopen.
test("parts with no header row save and reopen with that mode", async () => {
  const { dir, paths } = await copied();
  const file = join(dir, UNO);
  const first = connect(TINY, providers());
  let before: number;
  try {
    const src = await openOne(first.engine, threeAt(paths, "none"));
    await indexed(src);
    before = src.progress.rows;
    await writeFile(file, await first.engine.save({ source: src.id, cells: [], at: file }, ROOMY));
  } finally {
    first.done();
  }

  const source = held(await readFile(file), file);
  expect(source.header).toBe("none");
  // Every part is taken whole.
  expect(source.parts!.map((part) => part.skip)).toEqual([0, 0, 0]);

  const { engine, done } = connect(TINY, providers());
  try {
    const src = await openOne(engine, { name: UNO, path: file });
    await indexed(src);
    expect(src.progress.rows).toBe(before);
  } finally {
    done();
  }
});

// ------------------------------------------------------------ unopened parts

/** A promise and its resolver. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The path prefix of parts in the memory provider. */
const MEMORY = "memory://";

/**
 * memory is a provider over the fixture's parts in memory. It records which
 * parts were asked for and, when `holding`, hands none over until released.
 */
function memory(holding = false) {
  /** Every part an open asked for, in order. */
  const asked: string[] = [];
  /** Every part an open was handed, in order. */
  const handed: string[] = [];
  const gates = new Map(
    PART_NAMES.map((name) => {
      const held = gate();
      if (!holding) held.open();
      return [name, held];
    }),
  );
  const first = gate();
  const bytesOf = new Map(PART_NAMES.map((name, i) => [name, partBytes[i]!]));

  const provider: Provider = {
    name: "memory",
    label: "memory",
    files: {
      label: "memory",
      handles: (ref) => "path" in ref && ref.path.startsWith(MEMORY),
      async open(ref) {
        const file = bytesOf.get(ref.name);
        if (file === undefined) throw new Error(`${ref.name}: no such file`);
        asked.push(ref.name);
        first.open();
        await gates.get(ref.name)!.promise;
        handed.push(ref.name);
        return bytesSource(file);
      },
    },
  };
  return {
    provider,
    asked,
    handed,
    /** Resolves once any part has been asked for. */
    first: first.promise,
    release: (name: string) => gates.get(name)!.open(),
  };
}

/** Waits SETTLE_MS for any other open to be asked. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}
const SETTLE_MS = 50;

test("a reopened source opens no part until a read reaches it", async () => {
  const paths = PART_NAMES.map((name) => MEMORY + name);
  const first = connect(TINY, providers([memory().provider]));
  let made: Saved;
  try {
    made = await saved(first.engine, threeAt(paths), SHALLOW, "");
  } finally {
    first.done();
  }
  expect(held(made.uno).parts).toEqual(measured(paths, NO_VERSIONS));

  const m = memory(true);
  const { engine, done } = connect(TINY, providers([m.provider]));
  try {
    const opening = engine.open({ name: UNO, blob: new Blob([made.uno.slice()]) });

    // Only the first part is asked for.
    await m.first;
    await settled();
    expect(m.asked).toEqual([PART_NAMES[0]]);

    // With the first part alone the open answers. The third stays unasked.
    m.release(PART_NAMES[0]!);
    const { sources } = await opening;
    const src = sources[0]!;
    expect(m.handed).toEqual([PART_NAMES[0]]);
    expect(m.asked).not.toContain(PART_NAMES[2]);
    expect((await src.rows(SHALLOW[0]!.row, 1)).rows[0]![UNITS]).toBe(SHALLOW[0]!.now);

    // The index continues into the other parts once released.
    m.release(PART_NAMES[1]!);
    m.release(PART_NAMES[2]!);
    await indexed(src);
    expect(m.handed).toEqual(PART_NAMES);
    expect(await everyRow(src)).toEqual(made.rows);
  } finally {
    done();
  }
});

// ------------------------------------------------------------ a part that changed

/** Part two cut short of its last row. */
function shortened(): Uint8Array {
  const whole = partBytes[1]!;
  return whole.slice(0, whole.lastIndexOf(LF, whole.length - 2) + 1);
}

describe("a part changed on disk after the save", () => {
  const CHANGED = (now: number): string =>
    `${PART_NAMES[1]} (part 2 of ${PARTS}): it is not the file this source was made from · it is ${now} bytes and was ${partBytes[1]!.length}`;

  // An edit is in the third part, so the open reads through the second.
  test("is refused by name as the workspace opens, and the log is kept", async () => {
    const { uno, paths, file } = await savedOnDisk(EDITS);
    await writeFile(paths[1]!, shortened());

    const { engine, done } = connect(TINY, providers());
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      expect(saidIn(src.opened.link?.missing)).toBe(CHANGED(shortened().length));
      expect(src.opened.edits).toHaveLength(EDITS.length);
      // A relink to one file is refused.
      await expect(engine.relink(src, { name: PART_NAMES[1]!, path: paths[1]! })).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and ${PART_NAMES[1]} is one file`,
      );

      // A save writes the parts and log back as they were.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });

  // The only edit is in the first part, so the open reads only that part. The
  // index reads the second, and reports it through onError.
  test("is refused by name by the read that reaches it", async () => {
    const { uno, paths, file } = await savedOnDisk(SHALLOW);
    await writeFile(paths[1]!, shortened());

    const { engine, done } = connect(TINY, providers());
    const said = new Promise<string>((resolve) => {
      engine.onError = (heard) => resolve(english(heard));
    });
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      expect(src.opened.link).toBeUndefined();
      expect(await said).toBe(`${NAME}: ${CHANGED(shortened().length)}`);
      // Rows of the changed part are empty. The first part still reads.
      expect((await src.rows(PART_ROWS + 5, 1)).rows).toEqual([]);
      expect((await src.rows(SHALLOW[0]!.row, 1)).rows[0]![UNITS]).toBe(SHALLOW[0]!.now);

      // A save keeps the parts as recorded.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file).parts).toEqual(held(uno, file).parts);
      expect(readContainer(UNO, again, file).log).toHaveLength(SHALLOW.length);
    } finally {
      done();
    }
  });

  test("a part that has gone is named, and comes back with every edit once it does", async () => {
    const { uno, rows, paths, file } = await savedOnDisk(EDITS);
    await rm(paths[1]!);

    const gone = connect(TINY, providers());
    try {
      const src = await openOne(gone.engine, { name: UNO, path: file });
      expect(saidIn(src.opened.link?.missing)).toContain(`${PART_NAMES[1]} (part 2 of ${PARTS}): `);
      const again = await gone.engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      await writeFile(file, again);
    } finally {
      gone.done();
    }

    await copyFile(PART_FIXTURES[1]!, paths[1]!);
    const { engine, done } = connect(TINY, providers());
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      await indexed(src);
      expect(src.opened.link).toBeUndefined();
      expect(await everyRow(src)).toEqual(rows);
    } finally {
      done();
    }
  });
});

// ------------------------------------------------------------ a part that has gone

/** Part two's name after it is moved. */
const MOVED = "sales-q3-part-2-moved.csv";

describe("a part deleted after the save", () => {
  const SECOND = `${PART_NAMES[1]} (part 2 of ${PARTS}): `;

  test("opens the source with no rows, naming the part, and re-pointed it has every edit", async () => {
    const { uno, rows, dir, paths, file } = await savedOnDisk(EDITS);
    await rm(paths[1]!);

    const { engine, done } = connect(TINY, providers());
    try {
      const gone = await openOne(engine, { name: UNO, path: file });
      expect(saidIn(gone.opened.link?.missing)).toContain(SECOND);
      expect(gone.opened.edits).toHaveLength(EDITS.length);
      await expect(gone.rows(0, 1)).rejects.toThrow("point it at one to read its rows");

      // Relinks to one file, to two parts, or to the same paths are refused.
      await expect(engine.relink(gone, { name: PART_NAMES[1]!, path: paths[1]! })).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and ${PART_NAMES[1]} is one file`,
      );
      await expect(engine.relink(gone, threeAt(paths.slice(0, 2)))).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and cannot be pointed at 2`,
      );
      await expect(engine.relink(gone, threeAt(paths))).rejects.toThrow(SECOND);

      // Part two is copied elsewhere and the source relinked to it.
      const moved = join(dir, MOVED);
      await copyFile(PART_FIXTURES[1]!, moved);
      const at = [paths[0]!, moved, paths[2]!];
      const src = await engine.relink(gone, threeAt(at));
      await indexed(src);
      expect(src.id).toBe(gone.id);
      expect(src.opened.link?.missing).toBeUndefined();
      expect(src.opened.edits).toHaveLength(EDITS.length);
      expect(await everyRow(src)).toEqual(rows);

      // A save points at the new path, with the same log.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file).parts).toEqual(measured(at, NO_VERSIONS));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });

  // The only edit is in the first part, so the index is what finds part two
  // gone.
  test("is named by the read that reaches it, and the source is re-pointed the same way", async () => {
    const { rows, dir, paths, file } = await savedOnDisk(SHALLOW);
    await rm(paths[1]!);

    const { engine, done } = connect(TINY, providers());
    const said = new Promise<string>((resolve) => {
      engine.onError = (heard) => resolve(english(heard));
    });
    try {
      const gone = await openOne(engine, { name: UNO, path: file });
      expect(gone.opened.link).toBeUndefined();
      expect(await said).toContain(`${NAME}: ${SECOND}`);

      // A relink checks every part.
      await expect(engine.relink(gone, threeAt(paths))).rejects.toThrow(SECOND);
      expect((await gone.rows(SHALLOW[0]!.row, 1)).rows[0]![UNITS]).toBe(SHALLOW[0]!.now);

      const moved = join(dir, MOVED);
      await copyFile(PART_FIXTURES[1]!, moved);
      const src = await engine.relink(gone, threeAt([paths[0]!, moved, paths[2]!]));
      await indexed(src);
      expect(src.opened.edits).toHaveLength(SHALLOW.length);
      expect(await everyRow(src)).toEqual(rows);
    } finally {
      done();
    }
  });

  // A relink to a part of another size is refused.
  test("is not replaced by another file, which is refused by name", async () => {
    const { uno, dir, paths, file } = await savedOnDisk(EDITS);
    await rm(paths[1]!);
    const other = join(dir, MOVED);
    await writeFile(other, shortened());

    const { engine, done } = connect(TINY, providers());
    try {
      const gone = await openOne(engine, { name: UNO, path: file });
      await expect(engine.relink(gone, threeAt([paths[0]!, other, paths[2]!]))).rejects.toThrow(
        `${SECOND}it is not the file this source was made from · it is ${shortened().length} bytes and was ${partBytes[1]!.length}`,
      );

      // After the refusal the source is as saved.
      const again = await engine.save({ source: gone.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });
});

// ------------------------------------------------------------ in a bucket

/** The parts' keys in the stand-in bucket, under the connection's prefix. */
const KEYS_IN_BUCKET = PART_NAMES.map((name) => `2025/${name}`);

/** The first part on disk and the other two in the bucket. */
const ACROSS = [
  PART_FIXTURES[0]!,
  ...KEYS_IN_BUCKET.slice(1).map((key) => `s3://${BUCKET}/${key}`),
];

/** A versioned bucket holding all three parts. */
const HISTORY = "acme-history";
const IN_HISTORY = PART_NAMES.map((name) => `s3://${HISTORY}/${name}`);

const EXPORTS: Connection = {
  format: 1,
  id: "acme-exports",
  name: "ACME exports",
  provider: "s3",
  bucket: BUCKET,
  prefix: "2025/",
  auth: { mode: "machine" },
  created: undefined,
  modified: undefined,
};

const KEPT: Connection = { ...EXPORTS, id: "acme-history", bucket: HISTORY, prefix: "" };

/** Part two with one digit of its last row changed: same size, different bytes. */
function rewritten(): Uint8Array {
  const body = partBytes[1]!.slice();
  const at = body.findLastIndex((byte) => byte >= ZERO && byte <= NINE);
  body[at] = body[at] === ZERO ? NINE : ZERO;
  return body;
}
const ZERO = 0x30;
const NINE = 0x39;

describe("parts in a bucket", () => {
  const objects = new Map<string, Uint8Array>();
  const history = new Map<string, Uint8Array>();
  let b: Bucket;

  beforeAll(async () => {
    b = await bucket(undefined, HOME_REGION, objects, {
      [HISTORY]: { objects: history, keys: KEYS, versioned: true },
    });
  });
  afterAll(() => b.close());
  beforeEach(() => {
    KEYS_IN_BUCKET.forEach((key, i) => objects.set(key, partBytes[i]!));
    PART_NAMES.forEach((name, i) => history.set(name, partBytes[i]!));
  });

  const env = keysOnly;

  /** An engine wired like the desktop, with a multi provider. */
  async function desktop(connections: Connection[]) {
    const dir = await mkdtemp(join(tmpdir(), "uno-multisave-connections-"));
    const store = nodeStore();
    for (const c of connections) await saveConnection(store, dir, c);
    const kept = connectionsIn(store, dir);
    const single = [
      diskProvider(),
      s3Provider({ credentials: connectionSigning(() => kept.all, env()), endpoint: b.endpoint }),
    ];
    const made = connect(TINY, [...single, multiProvider(single)], {
      connections: kept,
      meet: connectionMeeting(() => kept.all),
    });
    return { ...made, store, dir };
  }

  /** Saves the parts at `paths` from an engine with both connections. */
  async function savedAcross(
    paths: readonly string[],
    edits: ReadonlyArray<{ row: number; now: string }>,
  ) {
    const file = join(await mkdtemp(join(tmpdir(), "uno-multisave-")), UNO);
    const { engine, done } = await desktop([EXPORTS, KEPT]);
    try {
      const made = await saved(engine, threeAt(paths), edits, file);
      await writeFile(file, made.uno);
      return { ...made, file };
    } finally {
      done();
    }
  }

  test("are saved with the version each was read as, and the connection they came through", async () => {
    const { uno, rows, file } = await savedAcross(ACROSS, EDITS);
    const source = held(uno, file);
    // A part on a disk is recorded with an undefined version, and one in a
    // bucket with its ETag.
    expect(source.parts).toEqual(
      measured(ACROSS, [undefined, etagOf(partBytes[1]!), etagOf(partBytes[2]!)]),
    );
    expect(source.connection).toBe(EXPORTS.id);

    const { engine, done } = await desktop([EXPORTS]);
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      await indexed(src);
      expect(await everyRow(src)).toEqual(rows);
    } finally {
      done();
    }
  });

  // Same size, so only the version shows the change.
  test("a part rewritten at the same size is refused by name, by its version", async () => {
    const { uno, file } = await savedAcross(ACROSS, EDITS);
    objects.set(KEYS_IN_BUCKET[1]!, rewritten());
    expect(rewritten().length).toBe(partBytes[1]!.length);

    const { engine, done } = await desktop([EXPORTS]);
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      expect(saidIn(src.opened.link?.missing)).toBe(
        `${PART_NAMES[1]} (part 2 of ${PARTS}): it is not the version this source was saved against`,
      );
      // The save keeps the recorded versions.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
    } finally {
      done();
    }
  });

  test("in a bucket that keeps versions reopen as the bytes that were saved", async () => {
    const { uno, rows, file } = await savedAcross(IN_HISTORY, EDITS);
    expect(held(uno, file).parts!.map((part) => part.version)).toEqual(
      partBytes.map((body) => versionIdOf(body)),
    );

    history.set(PART_NAMES[1]!, shortened());
    const { engine, done } = await desktop([KEPT]);
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      await indexed(src);
      expect(src.opened.link).toBeUndefined();
      expect(await everyRow(src)).toEqual(rows);
    } finally {
      done();
    }
  });

  // One part in an unconnected bucket keeps every part unread, including the
  // one on disk.
  test("no connection covers are not read at all, and the source waits with its log", async () => {
    const { uno, file } = await savedAcross(ACROSS, EDITS);

    const from = b.seen.length;
    const { engine, done } = await desktop([]);
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      expect(src.opened.link).toEqual({
        path: "",
        missing: { t: "bucket-unconnected", container: UNO, bucket: BUCKET },
        connect: { bucket: BUCKET, prefix: "2025/" },
      });
      expect(src.opened.edits).toHaveLength(EDITS.length);
      expect(b.seen.slice(from), "not a HEAD").toEqual([]);

      // Saved back unchanged: parts, versions, connection and log.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
      expect(b.seen.slice(from)).toEqual([]);
    } finally {
      done();
    }
  });

  // After the bucket is connected, a relink names a part that is gone. Once
  // it is back, the source reads.
  test("stop waiting once the bucket is connected, and read once every part is there", async () => {
    const { rows, file } = await savedAcross(ACROSS, EDITS);
    objects.delete(KEYS_IN_BUCKET[2]!);

    const { engine, done, store, dir } = await desktop([]);
    try {
      const waiting = await openOne(engine, { name: UNO, path: file });
      expect(waiting.opened.link?.connect).toEqual({ bucket: BUCKET, prefix: "2025/" });

      await saveConnection(store, dir, EXPORTS);
      await engine.connections();
      const gone = await engine.relink(waiting, threeAt(ACROSS));
      expect(gone.opened.link).toEqual({
        path: "",
        missing: {
          t: "text",
          text: `${PART_NAMES[2]} (part 3 of ${PARTS}): ${ACROSS[2]}: no such object in that bucket`,
        },
      });
      expect(gone.opened.edits).toHaveLength(EDITS.length);

      objects.set(KEYS_IN_BUCKET[2]!, partBytes[2]!);
      const src = await engine.relink(gone, threeAt(ACROSS));
      await indexed(src);
      expect(await everyRow(src)).toEqual(rows);
    } finally {
      done();
    }
  });
});

test("saving the workspace over one of the parts is refused", async () => {
  const { paths } = await copied();
  const { engine, done } = connect(TINY, providers());
  try {
    const over = paths[1]!;
    await expect(saved(engine, threeAt(paths), [], over)).rejects.toThrow(
      `${over} is where ${NAME} is read from · saving the workspace there would write over it`,
    );
  } finally {
    done();
  }
});
