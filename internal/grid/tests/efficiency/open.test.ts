// What a person waits on between asking for an object and seeing its rows.
//
// The reads are let through one at a time, the one nearest the front of the
// object first, until the open answers. What had to arrive by then is what the
// open waited on: reads asked for ahead sit further into the object and are
// still at the door. On a slow line the bytes are the wait.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import { record } from "./record.ts";
import { remote, repeated } from "./remote.ts";
import type { Remote } from "./remote.ts";

/** 24 MB: three of the chunks indexing really reads, so the first is a whole one. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

/** The most requests an open may wait on. */
const REQUESTS_BUDGET = 4;
/** The most bytes an open may wait on. */
const BYTES_BUDGET = 8_600_000;

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

test("opening an object waits on its first rows and little else", async () => {
  r = await remote(OBJECT, TUNING);
  const door = r.door;
  await door.during(r.open(), () => door.letLowest());

  const { requests, bytes } = door.since(0, door.passed);
  record("open", [
    { name: "open: requests waited on", unit: "requests", value: requests },
    { name: "open: bytes waited on", unit: "bytes", value: bytes },
  ]);
  expect(requests).toBeLessThanOrEqual(REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(BYTES_BUDGET);
}, 60_000);
