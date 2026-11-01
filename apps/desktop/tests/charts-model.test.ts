/**
 * @fileoverview A workspace's charts over the real engine. The model mirrors
 * the records the engine holds, showing a change at once.
 */

import { expect, test } from "vite-plus/test";

import { connect } from "@core-tests/engine/harness";
import { readContainer } from "@document";
import type { Chart, ChartColumn } from "@document";
import type { SourceRef } from "@engine";
import { REGION, UNITS } from "@main/smoke/fixture";
import type { Shown } from "@renderer/charts";
import { Workspace } from "@renderer/workspace";
import { ADS, BARS, SALES, unoOf } from "./charted.ts";
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

test("a chart the engine refuses shows until it answers, and then goes", async () => {
  await opened(FILE, async (w) => {
    const held = await w.charts.add(BARS);
    const refused = w.charts.add({ ...BARS, source: "gone" });
    expect(w.charts.all.map((c) => c.source)).toStrictEqual([BARS.source, "gone"]);
    await expect(refused).rejects.toThrow("no source");
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

test("a change shows at once, and one sent behind it, or behind a relink, builds on it", async () => {
  const both = { ...BARS, title: "Rows", refresh: 5 };
  await opened(uno(unoOf([BARS])), async (w) => {
    const relinked = w.relink(w.active, FILE);
    const changes = [
      w.charts.change(BARS.id, { title: both.title }),
      w.charts.change(BARS.id, { refresh: both.refresh }),
    ];
    expect(w.charts.all).toStrictEqual([both]);
    await Promise.all([relinked, ...changes]);
    expect(w.charts.all).toStrictEqual([both]);
    expect(await savedCharts(w)).toStrictEqual([both]);
  });
});

test("a refused change puts back what the engine answered for, under any later one", async () => {
  const titled = { ...BARS, title: "Rows" };
  await opened(uno(unoOf([BARS])), async (w) => {
    const landing = w.charts.change(BARS.id, { title: titled.title });
    await expect(w.charts.change(BARS.id, { source: "gone" })).rejects.toThrow("no source");
    await landing;
    expect(w.charts.all).toStrictEqual([titled]);

    const refused = w.charts.change(BARS.id, { source: "gone" });
    const later = w.charts.change(BARS.id, { source: BARS.source, refresh: 5 });
    await expect(refused).rejects.toThrow("no source");
    expect(w.charts.all).toStrictEqual([{ ...titled, refresh: 5 }]);
    await later;
  });
});

test("a chart on its way out takes no other request", async () => {
  await opened(uno(unoOf([BARS])), async (w) => {
    const removed = w.charts.remove(BARS.id);
    expect(w.charts.all).toStrictEqual([]);
    const said = { said: { t: "no-such-chart", id: BARS.id } };
    await expect(w.charts.change(BARS.id, { title: "x" })).rejects.toMatchObject(said);
    await expect(w.charts.remove(BARS.id)).rejects.toMatchObject(said);
    await removed;
    expect(await savedCharts(w)).toBeUndefined();
  });
});

test("a removal the engine refuses puts the chart back where it stood", async () => {
  const second = { ...BARS, id: "c2" };
  await opened(uno(unoOf([BARS, second])), async (w) => {
    w.close();
    const refused = w.charts.remove(BARS.id);
    expect(w.charts.all).toStrictEqual([second]);
    await expect(refused).rejects.toThrow("the engine was closed");
    expect(w.charts.all).toStrictEqual([BARS, second]);
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

test("a chart sent over a source on its way out stays where the engine holds it", async () => {
  await opened(uno(unoOf([BARS])), async (w) => {
    const other = w.sources[1]!;
    const removed = w.remove(other);
    const refused = w.charts.change(BARS.id, { source: other.id });
    await removed;
    await expect(refused).rejects.toThrow("no source");
    expect(w.charts.all).toStrictEqual([BARS]);
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

test("a just-opened file is clean", async () => {
  await opened(FILE, async (w) => expect(w.dirty).toBe(false));
});

test("adding, removing, and changing a chart's source, kind, columns, title or schedule mark it unsaved", async () => {
  const by: ChartColumn = { col: REGION, header: "region" };
  const units: ChartColumn = { col: UNITS, header: "units" };
  const scatter: Chart = { ...BARS, id: "c2", plot: { t: "scatter", x: by, y: units } };
  const changes: ReadonlyArray<readonly [Chart, Partial<Shown>]> = [
    [BARS, { title: "Rows" }],
    [BARS, { refresh: 5 }],
    [BARS, { source: ADS }],
    [BARS, { plot: { t: "pie", by } }],
    [BARS, { plot: { t: "bars", by: units } }],
    [BARS, { plot: { t: "bars", by: { ...by, header: "area" } } }],
    [BARS, { plot: { t: "bars", by, sum: units } }],
    [scatter, { plot: { t: "scatter", x: by, y: by } }],
  ];
  await opened(uno(unoOf([BARS, scatter])), async (w) => {
    for (const [chart, shown] of changes) {
      await w.charts.change(chart.id, shown);
      expect(w.dirty, JSON.stringify(shown)).toBe(true);
      await w.charts.change(chart.id, chart);
      expect(w.dirty, "as it was saved").toBe(false);
    }
    const added = await w.charts.add(BARS);
    expect(w.dirty, "a new chart").toBe(true);
    await w.charts.remove(added.id);
    expect(w.dirty, "the new chart gone").toBe(false);
    await w.charts.remove(BARS.id);
    expect(w.dirty, "a saved chart gone").toBe(true);
  });
});

test("a save clears the mark only once the file is written", async () => {
  await opened(FILE, async (w) => {
    await w.charts.add(BARS);
    // A failed host.save: the bytes were made, and saved() never comes.
    await bytesOf(w);
    expect(w.dirty).toBe(true);
    await bytesOf(w);
    w.saved(UNO);
    expect(w.dirty).toBe(false);
  });
});

test("a chart waiting on the engine counts as unsaved", async () => {
  await opened(uno(unoOf([BARS])), async (w) => {
    const changed = w.charts.change(BARS.id, { title: BARS.title });
    expect(w.dirty, "on its way").toBe(true);
    await changed;
    expect(w.dirty, "landed, and the same as saved").toBe(false);
  });
});

test("a save records the chart sent before it, and leaves the one sent after it unsaved", async () => {
  await opened(FILE, async (w) => {
    const save = (): Promise<void> => bytesOf(w).then(() => w.saved(UNO));
    const [made] = await Promise.all([w.charts.add(BARS), save()]);
    expect(w.dirty, "written by the save").toBe(false);

    const [, after] = await Promise.all([save(), w.charts.add(BARS)]);
    expect(w.dirty, "sent after the save").toBe(true);
    await w.charts.remove(after.id);
    expect(w.dirty, "gone again").toBe(false);

    const refused = expect(w.charts.change(made.id, { source: "gone" })).rejects.toThrow();
    await Promise.all([refused, save()]);
    expect(w.dirty, "refused before the save").toBe(false);
  });
});

test("a chart that lands while the host writes the file stays unsaved", async () => {
  await opened(uno(unoOf([BARS])), async (w) => {
    await bytesOf(w);
    const added = await w.charts.add(BARS);
    w.saved(UNO);
    expect(w.dirty, "added since the bytes").toBe(true);

    await bytesOf(w);
    await w.charts.remove(added.id);
    w.saved(UNO);
    expect(w.dirty, "removed since the bytes").toBe(true);
  });
});
