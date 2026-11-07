/**
 * @fileoverview The finder on its own: what it says, where it moves the grid,
 * and which answers it drops.
 */

import { afterEach, expect, test, vi } from "vite-plus/test";

import type { FindRequest, Found } from "@engine";

import type { Grid } from "@renderer/grid";
import { Finder } from "@renderer/shell/find";
import type { Showing } from "@renderer/shell/find";
import type { Tab, Workspace } from "@renderer/workspace";

/** A tab with only a name. The finder compares tabs by identity. */
function tab(name: string): Tab {
  return { name } as unknown as Tab;
}

/**
 * Holds each find's resolve function until the test answers it, and the
 * active tab, which the test can change while a find is out.
 */
class Held {
  active: Tab;
  readonly asked: Array<(found: Found) => void> = [];
  /** What each find asked the engine, in the order asked. */
  readonly requests: FindRequest[] = [];
  /** Where the grid's selection is. */
  selection = { row: 0, col: 0 };
  /** The headers of the showing tab's columns, all of them number columns. */
  headers = ["amount"];

  constructor(readonly tabs: Tab[]) {
    this.active = tabs[0]!;
  }

  /** Answers the oldest find still out with a row. */
  answer(row: number): void {
    this.asked.shift()?.({ row, searched: row, complete: true });
  }

  /** Answers the oldest find still out with a null row. */
  miss(searched: number, complete: boolean): void {
    this.asked.shift()?.({ row: null, searched, complete });
  }
}

/** A workspace of `held`'s columns, whose finds `held` holds. */
function workspaceOf(held: Held): Workspace {
  return {
    rows: { columns: held.headers.map((header) => ({ header, kind: "num", flagged: false })) },
    get active(): Tab {
      return held.active;
    },
    find: (req: FindRequest): Promise<Found> => {
      held.requests.push(req);
      return new Promise((resolve) => held.asked.push(resolve));
    },
    indexed: () => 100,
  } as unknown as Workspace;
}

/** A grid that records where it was moved, with the selection `held` says. */
function grid(held: Held, moved: number[][]): Grid {
  return {
    selection: () => held.selection,
    moveTo: (row: number, col: number) => moved.push([row, col]),
  } as unknown as Grid;
}

function finder(held: Held, moved: number[][], said: string[]): Finder {
  const showing: Showing = { workspace: workspaceOf(held), grid: grid(held, moved) };
  return new Finder(
    () => showing,
    (text, isError) => said.push(isError === true ? `! ${text}` : text),
  );
}

test("a find that lands moves the grid to the row it found", async () => {
  const held = new Held([tab("ledger.csv"), tab("q3.csv")]);
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  f.search("refund", 1);
  held.answer(7);
  await Promise.resolve();

  expect(moved).toEqual([[7, 0]]);
  expect(said).toEqual([""]);
});

test("a find answered after the person moved to another tab moves nothing", async () => {
  const held = new Held([tab("ledger.csv"), tab("q3.csv")]);
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  f.search("refund", 1);
  // The active tab changes while the find is still out.
  held.active = held.tabs[1]!;
  held.answer(7);
  await Promise.resolve();

  expect(moved).toEqual([]);
  expect(said).toEqual([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The wait before the status bar says searching. */
const SLOW_MS = 250;

test("n goes on the way the last search went, N the other, from where the grid is now", async () => {
  const held = new Held([tab("ledger.csv")]);
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  held.selection = { row: 9, col: 0 };
  f.search("refund", -1);
  held.answer(4);
  await Promise.resolve();
  held.selection = { row: 4, col: 0 };
  f.next(false);
  held.answer(1);
  await Promise.resolve();
  f.next(true);
  held.answer(7);
  await Promise.resolve();

  expect(held.requests).toEqual([
    { col: 0, from: 9, dir: -1, match: { t: "text", text: "refund" } },
    { col: 0, from: 4, dir: -1, match: { t: "text", text: "refund" } },
    { col: 0, from: 4, dir: 1, match: { t: "text", text: "refund" } },
  ]);
  expect(moved).toEqual([
    [4, 0],
    [1, 0],
    [7, 0],
  ]);
});

test("n before any search, and Enter on an empty prompt, say so", () => {
  const held = new Held([tab("ledger.csv")]);
  const said: string[] = [];
  const f = finder(held, [], said);

  f.next(false);
  f.search("", 1);
  expect(held.requests).toEqual([]);
  expect(said).toEqual(["! nothing searched yet", "! nothing searched yet"]);
});

test("Enter on an empty prompt searches for the last text again, the way the prompt faces", async () => {
  const held = new Held([tab("ledger.csv")]);
  const moved: number[][] = [];
  const f = finder(held, moved, []);

  f.search("refund", 1);
  held.answer(3);
  await Promise.resolve();
  f.search("", -1);
  held.answer(1);
  await Promise.resolve();

  expect(held.requests.map((r) => [r.dir, r.match])).toEqual([
    [1, { t: "text", text: "refund" }],
    [-1, { t: "text", text: "refund" }],
  ]);
});

test("a find that reads to the end says so, and one the index has not reached says how far it got", async () => {
  const held = new Held([tab("ledger.csv")]);
  const said: string[] = [];
  const f = finder(held, [], said);

  f.search("refund", 1);
  held.miss(100, true);
  await Promise.resolve();
  f.search("refund", -1);
  held.miss(0, true);
  await Promise.resolve();
  f.search("refund", 1);
  held.miss(100, false);
  await Promise.resolve();

  expect(said).toEqual([
    '! "refund" is not below row 1 in amount',
    '! "refund" is not above row 1 in amount',
    '! "refund" is not below row 1 in amount · searched 100 rows · indexing 100%',
  ]);
});

test("a slow find says it is searching, and a newer one over it clears that with its own answer", async () => {
  vi.useFakeTimers();
  const held = new Held([tab("ledger.csv")]);
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  f.search("refund", 1);
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  expect(said).toEqual(["searching…"]);

  f.search("credit", 1);
  held.answer(7);
  held.answer(2);
  await vi.advanceTimersByTimeAsync(0);

  expect(moved).toEqual([[2, 0]]);
  expect(said).toEqual(["searching…", ""]);
});

test("a slow find dropped for a tab the person left takes its searching with it", async () => {
  vi.useFakeTimers();
  const held = new Held([tab("ledger.csv"), tab("q3.csv")]);
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  f.search("refund", 1);
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  expect(said).toEqual(["searching…"]);

  held.active = held.tabs[1]!;
  held.answer(7);
  await vi.advanceTimersByTimeAsync(0);

  expect(moved).toEqual([]);
  expect(said).toEqual(["searching…", ""]);
});

/** A find down `col` from above its first row for the cells a tally could not read as numbers. */
const down = (col: number): FindRequest => ({ col, from: -1, dir: 1, match: { t: "not-number" } });

test("a chart's not-numbers find starts above the first row of its column, lands where it finds one, and tries the next column on a miss", async () => {
  const held = new Held([tab("ledger.csv")]);
  held.headers = ["amount", "units"];
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  const done = f.notNumbers(held.headers.map((header, col) => ({ col, header })));
  held.miss(10, true);
  await vi.waitFor(() => expect(held.asked).toHaveLength(1));
  held.answer(7);
  await done;

  expect(held.requests).toEqual([down(0), down(1)]);
  expect(moved.join(" ")).toBe("0,0 0,1 7,1");
  expect(said).toEqual(["! nothing below row 1 in amount fails to parse as a number", ""]);
});

test("a chart's column is found by its header where it has moved, and one the tab has not is passed over", async () => {
  const held = new Held([tab("ledger.csv")]);
  held.headers = ["units", "amount"];
  const moved: number[][] = [];
  const f = finder(held, moved, []);

  const gone = { col: 0, header: "gone" };
  const done = f.notNumbers([gone, { col: 0, header: "amount" }]);
  held.answer(3);
  await done;

  expect(held.requests).toEqual([down(1)]);
  expect(moved.join(" ")).toBe("0,1 3,1");
});

test("a chart's not-numbers search ends with the tab the person left, and goes on to no column there", async () => {
  const held = new Held([tab("ledger.csv"), tab("q3.csv")]);
  held.headers = ["amount", "units"];
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  let ended = false;
  void f.notNumbers(held.headers.map((header, col) => ({ col, header }))).then(() => {
    ended = true;
  });
  held.active = held.tabs[1]!;
  held.miss(10, true);
  // A search that went on would ask down the next column, and wait on its answer.
  await vi.waitFor(() => expect(ended || held.asked.length > 0).toBe(true));

  expect(ended).toBe(true);
  expect(held.requests).toEqual([down(0)]);
  expect(moved.join(" ")).toBe("0,0");
  expect(said).toEqual([]);
});

test("a chart's not-numbers search ends with a find of the person's own over it, whose answer lands, and goes on to no column", async () => {
  const held = new Held([tab("ledger.csv")]);
  held.headers = ["amount", "units"];
  const moved: number[][] = [];
  const said: string[] = [];
  const f = finder(held, moved, said);

  let ended = false;
  void f.notNumbers(held.headers.map((header, col) => ({ col, header }))).then(() => {
    ended = true;
  });
  // ]f while the first column's find is out, then that find's answer, which is dropped.
  f.unparsed(1);
  held.answer(3);
  // A search that went on would ask down the next column, and wait on its answer.
  await vi.waitFor(() => expect(ended || held.asked.length > 1).toBe(true));
  held.answer(5);
  await Promise.resolve();

  expect(ended).toBe(true);
  expect(held.requests).toEqual([down(0), { col: 0, from: 0, dir: 1, match: { t: "unparsed" } }]);
  expect(moved.join(" ")).toBe("0,0 5,0");
  expect(said).toEqual([""]);
});
