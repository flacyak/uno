// The engine and a .uno of several files read as one: saving such a source
// as its parts, and opening the save again.
//
// A save points at every part and writes down what the join measured of it,
// so the next open places the parts without opening one and a part is read
// for the first time when a row in it is. It is held then to what the save
// recorded, because the log names rows by number and a part that is another
// file would move every row after it out from under its edits.

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
import { BUCKET, KEYS, bucket, etagOf, versionIdOf } from "../store/standin.ts";
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

/** More than any source here would need a save to carry. */
const ROOMY = 1 << 20;

const LF = 0x0a;

/** How long the header every part opens with is, its line ending included:
 * what the join leaves out of each part after the first. */
const HEADER_BYTES = partBytes[0]!.indexOf(LF) + 1;

/** A row in each part, and what its units are changed to. */
const EDITS = [
  { row: 1, now: "986" },
  { row: PART_ROWS + 5, now: "77" },
  { row: ROWS - 1, now: "4" },
];

/** One edit near the top, so an open has no reason to read past the first part. */
const SHALLOW = EDITS.slice(0, 1);

/** The parts as one ref, each at `paths[i]`. */
function threeAt(paths: readonly string[], header: HeaderMode = "first"): SourceRef {
  return {
    name: NAME,
    parts: paths.map((path, i) => ({ ref: { name: PART_NAMES[i]!, path } })),
    header,
  };
}

/** The places a part can be on a machine with no bucket, and over them several read as one. */
function providers(extra: Provider[] = []): Provider[] {
  const single = [diskProvider(), blobProvider(), ...extra];
  return [...single, multiProvider(single)];
}

/** A folder holding a copy of each part, which a test can change. */
async function copied(): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "uno-multisave-"));
  const paths = PART_NAMES.map((name) => join(dir, name));
  await Promise.all(paths.map((path, i) => copyFile(PART_FIXTURES[i]!, path)));
  return { dir, paths };
}

/** What a client is handed of the parts open as one source, edited and saved. */
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

/** The parts on disk in a folder of their own, saved beside them with `edits`. */
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

/** What a part of the fixture measures in the join, in order. */
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

// The task's own sentence, from the engine's side.
test("three parts open as one, edited in each part, save as format 6 and reopen the same", async () => {
  const { uno, rows, paths, file } = await savedOnDisk(EDITS);

  // What was written: every part where it is, and what the join measured of it.
  const doc = readContainer(UNO, uno, file);
  expect(doc.manifest.format).toBe(PARTS_VERSION);
  expect(doc.sources[0]).toMatchObject({
    id: NAME,
    name: NAME,
    parts: measured(paths, NO_VERSIONS),
    header: "first",
    rows: ROWS,
  });
  // Beside the workspace, so written relative to it, and the folder moves whole.
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

    // Every row is what it was, and every edit is on the cell it was made to.
    expect(await everyRow(src)).toEqual(rows);
    for (const e of EDITS) {
      expect((await src.rows(e.row, 1)).rows[0]![UNITS]).toBe(e.now);
      expect((await src.rows(e.row - 1, 1)).rows[0]![UNITS]).toBe(sales.raw(e.row - 1, UNITS));
    }

    // And it saves again as what it was opened from.
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
    // None of the parts' bytes are a save's to carry, whatever the limit.
    expect((await engine.save(place, 0)).length).toBeGreaterThan(0);

    await engine.remove(three);
    expect(readContainer(UNO, await engine.save(place, ROOMY)).manifest.format).toBe(
      POINTED_VERSION,
    );
  } finally {
    done();
  }
});

// A part dropped into a browser has no path, and a .uno points at parts.
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

// The mode is kept. What the engine makes of the rows is the same before and
// after: it has one way of reading a first line, whatever the mode.
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
  // Nothing is left out of any part.
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

/** A promise, and the way to keep it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Where a part held in memory is said to be. */
const MEMORY = "memory://";

/**
 * A provider over the fixture's parts held in memory, which says which parts
 * it was asked for and hands none over until it is let.
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

/** Long enough for anything asked for alongside the first part to have been. */
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

    // The header is in the first part, and that is the one part asked for. A
    // source that measured its parts again would have asked for all three.
    await m.first;
    await settled();
    expect(m.asked).toEqual([PART_NAMES[0]]);

    // With the first part in hand the open answers, the third part unopened.
    m.release(PART_NAMES[0]!);
    const { sources } = await opening;
    const src = sources[0]!;
    expect(m.handed).toEqual([PART_NAMES[0]]);
    expect(m.asked).not.toContain(PART_NAMES[2]);
    expect((await src.rows(SHALLOW[0]!.row, 1)).rows[0]![UNITS]).toBe(SHALLOW[0]!.now);

    // The index reads on into the others as they are handed over.
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

/** Part two with its last row gone: a shorter file under the same name. */
function shortened(): Uint8Array {
  const whole = partBytes[1]!;
  return whole.slice(0, whole.lastIndexOf(LF, whole.length - 2) + 1);
}

describe("a part changed on disk after the save", () => {
  const CHANGED = (now: number): string =>
    `${PART_NAMES[1]} (part 2 of ${PARTS}): it is not the file this source was made from · it is ${now} bytes and was ${partBytes[1]!.length}`;

  // The log names a row in the third part, so the open reads through the
  // second to place it, and finds it is another file.
  test("is refused by name as the workspace opens, and the log is kept", async () => {
    const { uno, paths, file } = await savedOnDisk(EDITS);
    await writeFile(paths[1]!, shortened());

    const { engine, done } = connect(TINY, providers());
    try {
      const src = await openOne(engine, { name: UNO, path: file });
      expect(saidIn(src.opened.link?.missing)).toBe(CHANGED(shortened().length));
      expect(src.opened.edits).toHaveLength(EDITS.length);
      // It is still several files, so it is not pointed at one.
      await expect(engine.relink(src, { name: PART_NAMES[1]!, path: paths[1]! })).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and ${PART_NAMES[1]} is one file`,
      );

      // A save writes it back as it was found: every part, and every edit.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });

  // The log stops in the first part, so the open has no need of the second.
  // The read that reaches it is what is refused.
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
      // The index is the read that gets there first, and says so.
      expect(await said).toBe(`${NAME}: ${CHANGED(shortened().length)}`);
      // No row of the changed part is given, and the first part is still
      // read, with its edit.
      expect((await src.rows(PART_ROWS + 5, 1)).rows).toEqual([]);
      expect((await src.rows(SHALLOW[0]!.row, 1)).rows[0]![UNITS]).toBe(SHALLOW[0]!.now);

      // And a save still keeps every part as the workspace recorded it.
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

/** What part two is called once it has been moved. */
const MOVED = "sales-q3-part-2-moved.csv";

describe("a part deleted after the save", () => {
  const SECOND = `${PART_NAMES[1]} (part 2 of ${PARTS}): `;

  // 4.5's own sentence: deleting part two leaves the source openable once
  // re-pointed, with every edit intact.
  test("opens the source with no rows, naming the part, and re-pointed it has every edit", async () => {
    const { uno, rows, dir, paths, file } = await savedOnDisk(EDITS);
    await rm(paths[1]!);

    const { engine, done } = connect(TINY, providers());
    try {
      const gone = await openOne(engine, { name: UNO, path: file });
      expect(saidIn(gone.opened.link?.missing)).toContain(SECOND);
      expect(gone.opened.edits).toHaveLength(EDITS.length);
      await expect(gone.rows(0, 1)).rejects.toThrow("point it at one to read its rows");

      // It is several files, so one file is not what it is pointed at, and
      // neither are the same parts while one of them is still gone.
      await expect(engine.relink(gone, { name: PART_NAMES[1]!, path: paths[1]! })).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and ${PART_NAMES[1]} is one file`,
      );
      await expect(engine.relink(gone, threeAt(paths.slice(0, 2)))).rejects.toThrow(
        `${NAME} is ${PARTS} files read as one, and cannot be pointed at 2`,
      );
      await expect(engine.relink(gone, threeAt(paths))).rejects.toThrow(SECOND);

      // Part two turns up somewhere else, and the source is pointed at it there.
      const moved = join(dir, MOVED);
      await copyFile(PART_FIXTURES[1]!, moved);
      const at = [paths[0]!, moved, paths[2]!];
      const src = await engine.relink(gone, threeAt(at));
      await indexed(src);
      expect(src.id).toBe(gone.id);
      expect(src.opened.link?.missing).toBeUndefined();
      expect(src.opened.edits).toHaveLength(EDITS.length);
      expect(await everyRow(src)).toEqual(rows);

      // A save points at the part where it is now, under the same log.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file).parts).toEqual(measured(at, NO_VERSIONS));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });

  // The log stops in the first part, so the open has no need of the second,
  // and the read that reaches it is what says it has gone. The source is
  // pointed at its parts again all the same.
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

      // No read has to reach a part for a re-point to find it gone.
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

  // The log names rows by number, so a part is held to what the save recorded
  // of it wherever it is: another file in its place would move every row
  // after it out from under its edits.
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

      // A refused re-point costs nothing: the source is as the save left it.
      const again = await engine.save({ source: gone.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
    } finally {
      done();
    }
  });
});

// ------------------------------------------------------------ in a bucket

/** Where the two later parts are in the stand-in, under the prefix a connection covers. */
const KEYS_IN_BUCKET = PART_NAMES.map((name) => `2025/${name}`);

/** The first part on a disk and the other two in the bucket: every part its own place. */
const ACROSS = [
  PART_FIXTURES[0]!,
  ...KEYS_IN_BUCKET.slice(1).map((key) => `s3://${BUCKET}/${key}`),
];

/** A versioned bucket beside it, holding all three parts. */
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

/** Part two rewritten at the same size: one digit of its last row is another. */
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

  const env = () => ({
    AWS_ACCESS_KEY_ID: KEYS.accessKeyId,
    AWS_SECRET_ACCESS_KEY: KEYS.secretAccessKey,
    AWS_REGION: HOME_REGION,
    AWS_PROFILE: undefined,
    AWS_CONFIG_FILE: "/nonexistent/config",
    AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/credentials",
  });

  /** An engine the way the desktop wires one, with several files as one listed. */
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

  /** The parts saved from a machine that has the connection, as the file it wrote. */
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
    // A part on a disk has no version, and one in a bucket has its ETag.
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

  // The same size, the same header and the same last byte, so nothing the
  // join measures has moved. Only the version says it is another file.
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
      // The save keeps the versions the log was made against, not the ones there now.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
    } finally {
      done();
    }
  });

  // An S3 VersionId pins the exact bytes, so a shared workspace reopens the
  // same data whatever has been written over a part since.
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

  // A workspace somebody sent reads no bucket this machine has not connected.
  // One part in such a bucket keeps every part unread, the one on a disk too.
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

      // Saved back as it came: the parts, their versions, the hint and the log.
      const again = await engine.save({ source: src.id, cells: [], at: file }, ROOMY);
      expect(held(again, file)).toEqual(held(uno, file));
      expect(readContainer(UNO, again, file).log).toEqual(readContainer(UNO, uno, file).log);
      expect(b.seen.slice(from)).toEqual([]);
    } finally {
      done();
    }
  });

  // Connecting the bucket is what the source waited for. Pointed at the parts
  // it already names, it stops waiting whether or not they are all there: a
  // part that has gone is said by name, and with it back the source reads.
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
