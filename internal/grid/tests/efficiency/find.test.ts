// Measures a find that reads to the end of a 24 MB file, plain and beside a
// formula bound to another column. The bound column must keep it near plain
// speed.

import { afterEach, expect, test } from "vite-plus/test";

import { TUNING } from "../../src/engine/index.ts";
import type { Engine, Found, SourceHandle } from "../../src/engine/index.ts";
import { NO_ROW, Op } from "../../src/sheet/index.ts";
import { connect, indexed, openOne } from "../engine/harness.ts";
import { CHANNEL, REGION } from "../testdata/sales-q3.ts";
import { record } from "./record.ts";
import { repeated } from "./remote.ts";

/** 24 MB and 481,200 rows. */
const REPEATS = 100;
const OBJECT = repeated(REPEATS);

/** Text absent from every region cell, so a find for it reads every row. */
const NOWHERE = "nowhere";

/** How many times each find is run. The fastest run is kept. */
const SAMPLES = 3;

/** The most a find beside a bound column may cost, relative to a plain one. */
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

/** fastest runs the find SAMPLES times and returns the quickest. */
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
  // A find skips the row it starts from, so it searches one row fewer.
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
