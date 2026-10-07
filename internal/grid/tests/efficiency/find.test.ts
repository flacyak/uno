// What a find that reaches the end of a big file costs, beside a bound column.
//
// A find on one column reads every block from the row it starts at until it
// matches, so on a column with no match it is a pass over the file. The cells
// it has to look at are the ones in the column searched. What the log does to
// the other columns -- a formula bound to one of them, computed over every row
// of every block -- is not its concern, and a find should cost the same with
// such a column in the file as without one.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Engine, Found, SourceHandle } from "../../src/engine/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import { connect, indexed, openOne } from "../engine/harness.ts";
import { CHANNEL, REGION } from "../testdata/sales-q3.ts";
import { record } from "./record.ts";
import { repeated } from "./remote.ts";

/** 24 MB and 481,200 rows: a file a find takes long enough over to time. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

/** Text no region cell holds, so a find for it reads every row. */
const NOWHERE = "nowhere";

/** How many times each find is run. The fastest run is the cost; the rest is noise. */
const SAMPLES = 3;

/** The most a find beside a bound column may cost, per find with an empty log. */
const BOUND_BUDGET = 1.5;

let done: (() => void) | undefined;
afterEach(() => {
  done?.();
  done = undefined;
});

async function open(): Promise<{ engine: Engine; src: SourceHandle }> {
  const c = connect(TUNING);
  done = c.done;
  const src = await openOne(c.engine, { name: "big.csv", blob: new Blob([OBJECT]) });
  await indexed(src);
  return { engine: c.engine, src };
}

/** fastest runs a find SAMPLES times and answers with its shortest wall-clock time. */
async function fastest(src: SourceHandle): Promise<{ found: Found; ms: number }> {
  let best: { found: Found; ms: number } | undefined;
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    const found = await src.find({
      col: REGION,
      from: 0,
      dir: 1,
      match: { t: "text", text: NOWHERE },
    });
    const ms = performance.now() - started;
    if (best === undefined || ms < best.ms) best = { found, ms };
  }
  return best!;
}

test("a find on one column costs the same beside a bound column", async () => {
  const { engine, src } = await open();

  const plain = await fastest(src);
  // The row a find starts beside is never looked at, so one row fewer is searched.
  expect(plain.found).toEqual({ row: null, searched: src.progress.rows - 1, complete: true });

  engine.mode(true);
  await src.edit({ op: Op.Bind, row: NO_ROW, col: CHANNEL, now: "revenue / units" });
  const bound = await fastest(src);
  expect(bound.found).toEqual(plain.found);

  const times = bound.ms / plain.ms;
  record("find", [
    { name: "find to the end of 481k rows: ms", unit: "ms", value: plain.ms },
    { name: "find beside a bound column: ms per find with an empty log", unit: "x", value: times },
  ]);
  expect(times).toBeLessThanOrEqual(BOUND_BUDGET);
}, 120_000);
