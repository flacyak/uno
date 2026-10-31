/**
 * @fileoverview A workspace's charts over the real engine. The model mirrors
 * the records the engine holds.
 */

import { expect, test } from "vite-plus/test";

import { connect } from "@core-tests/engine/harness";
import { readContainer } from "@document";
import type { Chart } from "@document";
import type { SourceRef } from "@engine";
import { Workspace } from "@renderer/workspace";
import { BARS, SALES, unoOf } from "./charted.ts";
import { FIXTURE, SECOND } from "./smoke/dom-harness.ts";

/** The sales export alone, and the name a .uno goes by here. */
const FILE: SourceRef = { name: `${SALES}.csv`, path: FIXTURE };
const UNO = "q3.uno";

/** Opens `ref` in a workspace of its own, runs `use` over it, and closes it. */
async function opened(ref: SourceRef, use: (w: Workspace) => Promise<void>): Promise<void> {
  const ignore = (): void => {};
  const w = await Workspace.open(ref, connect().engine, "", ignore, ignore);
  try {
    await use(w);
  } finally {
    w.close();
  }
}

/** The .uno the engine writes for `w`. */
function bytesOf(w: Workspace): Promise<Uint8Array> {
  return w.bytes({ row: 0, col: 0 }, "");
}

/** The charts the engine writes for `w`, read back from its save. */
async function savedCharts(w: Workspace): Promise<readonly Chart[] | undefined> {
  return readContainer(UNO, await bytesOf(w)).charts;
}

/** A ref to `bytes` as a .uno. */
function uno(bytes: Uint8Array): SourceRef {
  return { name: UNO, blob: new Blob([new Uint8Array(bytes)]) };
}

test("adding, changing and removing a chart go through the engine", async () => {
  await opened(FILE, async (w) => {
    const first = await w.charts.add(BARS);
    const second = await w.charts.add({ ...BARS, title: "Second" });
    expect(w.charts.all).toStrictEqual([first, second]);
    expect(await savedCharts(w)).toStrictEqual([first, second]);

    await w.charts.change(first.id, { title: "Rows per region" });
    await w.charts.remove(second.id);
    const titled = { ...first, title: "Rows per region" };
    expect(w.charts.all).toStrictEqual([titled]);
    expect(await savedCharts(w)).toStrictEqual([titled]);
  });
});

test("a chart the engine refuses stays as it was", async () => {
  await opened(FILE, async (w) => {
    const held = await w.charts.add(BARS);
    await expect(w.charts.add({ ...BARS, source: "gone" })).rejects.toThrow("no source");
    await expect(w.charts.change(held.id, { source: "gone" })).rejects.toThrow("no source");
    expect(w.charts.all).toStrictEqual([held]);
  });
});

test("a chart that has gone cannot be changed or removed", async () => {
  await opened(FILE, async (w) => {
    const said = { said: { t: "no-such-chart", id: "c9" } };
    await expect(w.charts.change("c9", { title: "x" })).rejects.toMatchObject(said);
    await expect(w.charts.remove("c9")).rejects.toMatchObject(said);
  });
});

test("a removed source takes its charts out of the workspace", async () => {
  await opened(FILE, async (w) => {
    const other = await w.add({ name: "second.csv", path: SECOND });
    const kept = await w.charts.add(BARS);
    const gone = await w.charts.add({ ...BARS, source: other.id });
    expect(w.charts.over(other.id)).toStrictEqual([gone]);
    await w.remove(other);
    expect(w.charts.all).toStrictEqual([kept]);
    expect(await savedCharts(w)).toStrictEqual([kept]);
  });
});

test("a saved workspace reopens with its charts", async () => {
  await opened(FILE, async (w) => {
    expect(w.charts.all).toStrictEqual([]);
    const made = await w.charts.add(BARS);
    await opened(uno(await bytesOf(w)), async (back) => {
      expect(back.charts.all).toStrictEqual([made]);
    });
  });
});

test("a new chart takes no id the workspace holds or carries, whatever its name", async () => {
  const held = [BARS, { ...BARS, id: "revenue" }];
  const carried = ["c2", "c3"].map((id) => ({ id, source: SALES, json: `{"id":"${id}"}` }));
  await opened(uno(unoOf(held, carried)), async (w) => {
    const made = [await w.charts.add(BARS), await w.charts.add(BARS)];
    expect(made.map((c) => c.id)).toStrictEqual(["c4", "c5"]);
    await w.charts.remove("c5");
    expect((await w.charts.add(BARS)).id).toBe("c6");
  });
});
