// What a save costs once the bytes it carries have been saved before.
//
// A source with no file behind it is carried in the .uno, deflated, and its
// bytes never change: the log is what changes between one Ctrl+S and the
// next. Deflating 24 MB is the better part of a second during which the
// engine answers nothing, so the second save of the same bytes has to cost a
// fraction of the first.

import { expect, test } from "vite-plus/test";

import { newManifest, readContainer, writeDocument } from "../../src/document/index.ts";
import type { Document } from "../../src/document/index.ts";
import { bytes } from "../testdata/sales-q3.ts";
import { record } from "./record.ts";

/** 24 MB: the same object the open and band suites measure. */
const REPEATS = 100;

/** How many times cheaper than the first a save of the same bytes has to be.
 * The second still hashes them for the manifest and writes the container, so
 * it is not free; deflating them again is what it must not do. */
const CHEAPER = 2;

function carried(repeats: number): Uint8Array {
  const raw = new Uint8Array(bytes.length * repeats);
  for (let i = 0; i < repeats; i++) raw.set(bytes, i * bytes.length);
  return raw;
}

function workspace(raw: Uint8Array): Document {
  return {
    manifest: newManifest(),
    sources: [
      {
        id: "sales",
        name: "sales.csv",
        raw,
        bytes: raw.length,
        rows: 0,
        cols: 0,
        state: { active: { row: 0, col: 0 } },
      },
    ],
    active: "sales",
    log: [],
    extra: new Map(),
    at: "",
  };
}

/** Whether two arrays hold the same bytes. 24 MB is more than a matcher's
 * diff should be asked to walk. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function timed(fn: () => Uint8Array): { out: Uint8Array; ms: number } {
  const began = performance.now();
  const out = fn();
  return { out, ms: performance.now() - began };
}

test("a save of bytes already saved does not deflate them again", () => {
  const raw = carried(REPEATS);
  const doc = workspace(raw);
  const first = timed(() => writeDocument(doc));
  // The bytes a Blob is read into are fresh each save, so the second holds
  // the same bytes in another array, the way a dropped file does.
  doc.sources[0]!.raw = new Uint8Array(raw);
  const again = timed(() => writeDocument(doc));

  record("save", [
    { name: "save of 24 MB carried: first, ms", unit: "ms", value: first.ms },
    { name: "save of 24 MB carried: again, ms", unit: "ms", value: again.ms },
  ]);
  expect(again.ms).toBeLessThan(first.ms / CHEAPER);

  const back = readContainer("test.uno", again.out);
  expect(same(back.sources[0]!.raw!, raw), "the source went in byte for byte").toBe(true);
  expect(back.manifest.sources[0]!.sha256).toBe(
    readContainer("test.uno", first.out).manifest.sources[0]!.sha256,
  );
}, 60_000);
