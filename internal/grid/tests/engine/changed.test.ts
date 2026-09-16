// A reopened source says when it is not the file its log was made against.
//
// Where the save recorded a version, the version is the test: an export
// written over at the same size is a change no size could show, and the same
// version is the same bytes. A file with no version falls back to its size.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

import { formatBytes } from "../../src/engine/index.ts";
import type { SourceHandle } from "../../src/engine/index.ts";
import { Op } from "../../src/sheet/index.ts";
import { diskProvider } from "../../src/store/node.ts";
import { s3Provider } from "../../src/store/s3.ts";
import { HOME_REGION } from "../store/regions.ts";
import { KEYS, bucket } from "../store/standin.ts";
import type { Bucket } from "../store/standin.ts";
import { UNITS } from "../testdata/sales-q3.ts";
import { bytes, connect, indexed, openOne } from "./harness.ts";

const KEY = "2025/sales-q3.csv";
const PLAIN = `s3://acme-plain/${KEY}`;
const VERSIONED = `s3://acme-history/${KEY}`;

/** What each bucket holds now. A test writes over the object through these. */
const plain = new Map<string, Uint8Array>();
const history = new Map<string, Uint8Array>();

let b: Bucket;
beforeAll(async () => {
  b = await bucket(undefined, HOME_REGION, undefined, {
    "acme-plain": { objects: plain, keys: KEYS },
    "acme-history": { objects: history, keys: KEYS, versioned: true },
  });
});
afterAll(() => b.close());
beforeEach(() => {
  plain.set(KEY, bytes);
  history.set(KEY, bytes);
});

const providers = () => [
  diskProvider(),
  s3Provider({ credentials: () => Promise.resolve(KEYS), endpoint: b.endpoint }),
];

/**
 * The fixture with one digit of one row changed: the same size, and
 * different bytes, which is what an export regenerated with a corrected
 * figure looks like.
 */
function sameSizeRewrite(): Uint8Array {
  const out = bytes.slice();
  const body = out.indexOf(0x0a) + 1;
  const at = out.findIndex((c, i) => i > body && c >= 0x30 && c <= 0x39);
  out[at] = out[at] === 0x39 ? 0x30 : out[at]! + 1;
  return out;
}

/** A workspace of the object with one edit, saved, as the file it wrote. */
async function saved(path: string): Promise<string> {
  const { engine, done } = connect(undefined, providers());
  try {
    const src = await openOne(engine, { name: "sales-q3.csv", path });
    await indexed(src);
    engine.mode(true);
    await src.edit({ op: Op.Set, row: 1, col: UNITS, now: "986" });
    const file = join(await mkdtemp(join(tmpdir(), "uno-changed-")), "q3.uno");
    await writeFile(file, await engine.save({ source: src.id, cells: [], at: file }, 1 << 20));
    return file;
  } finally {
    done();
  }
}

async function reopened(file: string): Promise<{ src: SourceHandle; done: () => void }> {
  const { engine, done } = connect(undefined, providers());
  const { sources } = await engine.open({ name: "q3.uno", path: file });
  return { src: sources[0]!, done };
}

// The task's own sentence.
test("a same-size rewrite is reported as changed", async () => {
  const file = await saved(PLAIN);
  const rewritten = sameSizeRewrite();
  expect(rewritten.length).toBe(bytes.length);
  plain.set(KEY, rewritten);

  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.changed).toBe(
      "sales-q3.csv is not the version the workspace was saved against · it is the same size",
    );
    // Said and not acted on: the rows are there, with the edit replayed.
    await indexed(src);
    expect((await src.rows(1, 1)).rows[0]![UNITS]).toBe("986");
  } finally {
    done();
  }
});

test("an object nobody touched is not changed", async () => {
  const file = await saved(PLAIN);
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.changed).toBeUndefined();
  } finally {
    done();
  }
});

// Pinned by 3.2, so a rewrite in a versioned bucket reopens the saved bytes,
// and those are not a change.
test("an object written over in a versioned bucket reopens unchanged", async () => {
  const file = await saved(VERSIONED);
  history.set(KEY, sameSizeRewrite());
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.changed).toBeUndefined();
  } finally {
    done();
  }
});

test("a rewrite of another size says both sizes", async () => {
  const file = await saved(PLAIN);
  const longer = new Uint8Array([
    ...bytes,
    ...new TextEncoder().encode("2026-01-01,West,Ana,web,1,1\n"),
  ]);
  plain.set(KEY, longer);
  const { src, done } = await reopened(file);
  try {
    expect(src.opened.link?.changed).toBe(
      `sales-q3.csv is not the version the workspace was saved against · it is ${formatBytes(longer.length)} now and was ${formatBytes(bytes.length)}`,
    );
  } finally {
    done();
  }
});
