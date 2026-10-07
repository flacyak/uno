// Finding in a column over the engine's answer, with no window: what the
// finder says, where it moves the grid, and which answers it drops.

import { afterEach, expect, test, vi } from "vite-plus/test";

import type { FindRequest, Found } from "@uno/grid/engine";

import type { Grid } from "../src/renderer/grid/index.ts";
import { Finder } from "../src/renderer/shell/find.ts";
import type { Showing } from "../src/renderer/shell/find.ts";
import type { Tab, Workspace } from "../src/renderer/workspace.ts";

/** A tab with the one thing the finder reads of it: that it is this one and not another. */
function tab(name: string): Tab {
  return { name } as unknown as Tab;
}

/**
 * The finds still out, held until the test answers them, the way a find that
 * reads a long file is, and the tab showing meanwhile, which the test can
 * change the way gt does.
 */
class Held {
  active: Tab;
  readonly asked: Array<(found: Found) => void> = [];
  /** What each find asked the engine, in the order asked. */
  readonly requests: FindRequest[] = [];
  /** Where the grid's selection is. */
  selection = { row: 0, col: 0 };

  constructor(readonly tabs: Tab[]) {
    this.active = tabs[0]!;
  }

  /** answer lands the oldest find still out with a row. */
  answer(row: number): void {
    this.asked.shift()?.({ row, searched: row, complete: true });
  }

  /** miss lands the oldest find still out with nothing, having read the file. */
  miss(searched: number, complete: boolean): void {
    this.asked.shift()?.({ row: null, searched, complete });
  }
}

/** A workspace with the one column, whose finds `held` holds. */
function workspaceOf(held: Held): Workspace {
  return {
    rows: { columns: [{ header: "amount", kind: "num", flagged: false }] },
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

/** A grid that remembers where it was moved, and is where `held` says. */
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
  // gt, while the file is still being read: the row found is a row of the
  // tab left behind, and the grid now shows another.
  held.active = held.tabs[1]!;
  held.answer(7);
  await Promise.resolve();

  expect(moved).toEqual([]);
  expect(said).toEqual([]);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Past the wait a find gets before the status bar says it is searching. */
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
