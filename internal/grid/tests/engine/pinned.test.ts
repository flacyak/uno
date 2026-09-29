// A saved workspace opens the bytes its log was made against.
//
// A bucket with versioning on keeps every version of an object, so a .uno
// that recorded a VersionId asks for that one by name, and reopens the saved
// bytes after the object is written over or deleted. A bucket without
// versioning keeps no copy, so the object is read as it is now, every range
// pinned to the ETag it was opened at. A VersionId the bucket no longer has
// opens the object as it is now, and says which version that is.

import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

import { readContainer } from "../../src/document/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { HOME_REGION } from "../store/regions.ts";
import { KEYS, bucket, etagOf, versionIdOf } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { UNITS } from "../testdata/sales-q3.ts";
import { bytes, connect, indexed, openOne, sales } from "./harness.ts";

/** What the object is written over with: another export altogether. */
const OTHER = readFileSync(
  fileURLToPath(new URL("../testdata/google-ads-sales.csv", import.meta.url)),
);

const KEY = "2025/sales-q3.csv";
const VERSIONED = `s3://acme-history/${KEY}`;
const PLAIN = `s3://acme-plain/${KEY}`;

/** What each bucket holds now. A test writes over or deletes through these. */
const history = new Map<string, Uint8Array>();
const plain = new Map<string, Uint8Array>();

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-history": { objects: history, keys: KEYS, versioned: true },
    "acme-plain": { objects: plain, keys: KEYS },
  });
});
afterAll(() => b.close());
beforeEach(() => {
  history.set(KEY, bytes);
  plain.set(KEY, bytes);
  b.seen.length = 0;
});

const providers = () => [
  diskProvider(),
  s3Provider({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint }),
];

/** A workspace of the object with one edit, saved, as the file it wrote. */
async function saved(path: string): Promise<string> {
  const { engine, done } = connect(undefined, providers());
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", path });
    await indexed(src);
    engine.mode(true);
    await src.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const file = join(await mkdtemp(join(tmpdir(), "uno-pinned-")), "q3.uno");
    await writeFile(file, await engine.save({ source: src.id, cells: [], at: file }, 1 << 20));
    return file;
  } finally {
    done();
  }
}

/** The workspace opened again, and its one source indexed. */
async function reopened(file: string): Promise<{ src: SourceHandle; done: () => void }> {
  const { engine, done } = connect(undefined, providers());
  const { sources } = await engine.open({ name: "q3.uno", path: file });
  const src = sources[0]!;
  await indexed(src);
  return { src, done };
}

/** The requests that reached the object, as `METHOD query`. */
function asked(key: string): string[] {
  return b.seen.filter((s) => s.path.endsWith(key)).map((s) => `${s.method} ${s.query ?? ""}`);
}

// The task's own sentence.
test("an object overwritten in a versioned bucket still reopens the saved bytes", async () => {
  const file = await saved(VERSIONED);
  const version = versionIdOf(bytes);
  expect(readContainer("q3.uno", readFileSync(file)).sources[0]!.version).toBe(version);

  history.set(KEY, OTHER);
  b.seen.length = 0;
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link).toEqual({ path: VERSIONED, version });
    expect(src.opened.size).toBe(bytes.length);
    // The saved bytes, with the edit replayed over them.
    const rows = (await src.rows(0, 3)).rows;
    expect(rows[0]![UNITS]).toBe(sales.display(0, UNITS));
    expect(rows[1]![UNITS]).toBe("986");
    expect(rows[2]![UNITS]).toBe(sales.display(2, UNITS));
    // Every request named the version, encoded once, however its id is spelt.
    const q = `versionId=${encodeURIComponent(version)}`;
    const seen = asked(KEY);
    expect(seen.length).toBeGreaterThan(1);
    for (const s of seen) expect(s).toContain(q);
  } finally {
    done();
  }
});

test("and after it is deleted", async () => {
  const file = await saved(VERSIONED);
  history.delete(KEY);
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.missing).toBeUndefined();
    expect((await src.rows(1, 1)).rows[0]![UNITS]).toBe("986");
  } finally {
    done();
  }
});

// Versioning suspended, or the version deleted: the bytes are gone, and the
// object as it is now is the best there is. It says it is another version,
// which is what a change test has to go on.
test("a version the bucket no longer has opens the object as it is now, saying which", async () => {
  // A workspace saved against a version nobody kept.
  const { engine, done } = connect(undefined, providers());
  try {
    const { sources } = await engine.open({
      name: "sales-q3.csv",
      path: VERSIONED,
      version: "never+kept/this=",
    });
    const src = sources[0]!;
    await indexed(src);
    expect(src.opened.link).toEqual({ path: VERSIONED, version: versionIdOf(bytes) });
  } finally {
    done();
  }
});

test("an object in a bucket without versions is read as it is now, pinned to its ETag", async () => {
  const file = await saved(PLAIN);
  expect(readContainer("q3.uno", readFileSync(file)).sources[0]!.version).toBe(etagOf(bytes));

  plain.set(KEY, OTHER);
  b.seen.length = 0;
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.version).toBe(etagOf(OTHER));
    expect(src.opened.size).toBe(OTHER.length);
    // Nothing to name: S3 keeps no copy of the bytes behind an ETag.
    for (const s of asked(KEY)) expect(s).not.toContain("versionId");
  } finally {
    done();
  }
});
