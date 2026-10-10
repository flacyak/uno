// Measures the requests and bytes one jump of the grid costs: a band of
// BAND_ROWS asked for at once from the middle of an indexed object.

import { afterEach, expect, test } from "vite-plus/test";

import { BAND_ROWS } from "../../src/engine/client.ts";
import { TUNING } from "../../src/engine/index.ts";
import { indexed } from "../engine/harness.ts";
import { ROWS } from "../testdata/sales-q3.ts";
import { record } from "./record.ts";
import { remote, repeated } from "./remote.ts";
import type { Remote } from "./remote.ts";

/** 24 MB and 481,200 rows: three chunks at the default chunk size. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

/** The most requests one jump may send. */
const REQUESTS_BUDGET = 6;
/** The most bytes one jump may ask for. */
const BYTES_BUDGET = 310_000;

let r: Remote | undefined;
afterEach(async () => {
  await r?.close();
  r = undefined;
});

test("a jump to the middle of an indexed object is a few requests", async () => {
  r = await remote(OBJECT, TUNING);
  const src = await r.door.during(r.open());
  await r.door.during(indexed(src));
  await r.door.quiet();

  const before = r.door.asked.length;
  const middle = (ROWS * REPEATS) >> 1;
  const reply = await r.door.during(src.rows(middle, BAND_ROWS));
  // Read-ahead sent after the band counts toward the jump.
  await r.door.quiet();
  expect(reply.rows.length).toBe(BAND_ROWS);

  const { requests, bytes } = r.door.since(before);
  record("band", [
    { name: "band jump of 2,000 rows: requests", unit: "requests", value: requests },
    { name: "band jump of 2,000 rows: bytes asked for", unit: "bytes", value: bytes },
  ]);
  expect(requests).toBeLessThanOrEqual(REQUESTS_BUDGET);
  expect(bytes).toBeLessThanOrEqual(BYTES_BUDGET);
}, 60_000);
