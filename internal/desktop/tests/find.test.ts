// Finding in a column over the engine's answer, with no window: what the
// finder says, where it moves the grid, and which answers it drops.

import { expect, test } from "vite-plus/test";

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

  constructor(readonly tabs: Tab[]) {
    this.active = tabs[0]!;
  }

  /** answer lands the oldest find still out with a row. */
  answer(row: number): void {
    this.asked.shift()?.({ row, searched: row, complete: true });
  }
}

/** A workspace with the one column, whose finds `held` holds. */
function workspaceOf(held: Held): Workspace {
  return {
    rows: { columns: [{ header: "amount", kind: "num", flagged: false }] },
    get active(): Tab {
      return held.active;
    },
    find: (_req: FindRequest): Promise<Found> => new Promise((resolve) => held.asked.push(resolve)),
    indexed: () => 100,
  } as unknown as Workspace;
}

/** A grid that remembers where it was moved. */
function grid(moved: number[][]): Grid {
  return {
    selection: () => ({ row: 0, col: 0 }),
    moveTo: (row: number, col: number) => moved.push([row, col]),
  } as unknown as Grid;
}

function finder(held: Held, moved: number[][], said: string[]): Finder {
  const showing: Showing = { workspace: workspaceOf(held), grid: grid(moved) };
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
