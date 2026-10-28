/**
 * @fileoverview A source whose columns grow while it is indexed, drawn by the
 * real shell over a fake engine. Each edit carries the column count the grid
 * draws, and a tab's saved cell stays on its cell as _file moves right, while
 * one in a tab that had no columns stays where it is.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test } from "vite-plus/test";

import { Engine, messagePort } from "@engine";
import type { ColumnInfo, MessagePortLike, Reply, Request } from "@engine";
import type { Shell } from "@renderer/shell/shell";
import { Workspace } from "@renderer/workspace";
import { Op } from "@sheet";
import { FAKE_NAME, FakeEngine, cellAt } from "./fake-engine.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";
import { UNHEARD } from "./unheard.ts";

/** The columns the source's first lines hold. */
const KEYS: ColumnInfo[] = [
  { header: "id", kind: "num", flagged: false },
  { header: "event", kind: "text", flagged: false },
  { header: "page", kind: "text", flagged: false },
];

/** The column the source finds late: blank in every sample row, so text. */
const LATE: ColumnInfo = { header: "campaign", kind: "text", flagged: false };

/** The source as the one part of a source that shows each row's file in _file. */
const FILE: ColumnInfo = { header: "_file", kind: "text", flagged: false };
const FILED = [...KEYS, FILE];
const FILED_WIDE = [...KEYS, LATE, FILE];

/** The row a saved cell or the selection is left on before the widen. */
const ROW = 2;

const page = domPage();
let shell: Shell;
/** The columns the next engine opens its source with. */
let next = KEYS;
/** The engine the shell connected to last, which the workspace open now reads. */
let engine: FakeEngine | undefined;

/** connect starts a fake engine, as the host starts a real one. */
function connect(): Promise<MessagePortLike> {
  engine = new FakeEngine(next);
  return Promise.resolve(engine);
}

/** opened opens a workspace over a fake engine with `columns`, and waits for its rows. */
async function opened(columns: ColumnInfo[]): Promise<FakeEngine> {
  next = columns;
  await shell.openRef({ name: FAKE_NAME, path: `/${FAKE_NAME}` });
  expect(await page.until([{ row: 0, col: 0, equals: cellAt(columns[0]!, 0) }])).toBe(true);
  return engine!;
}

beforeAll(async () => {
  shell = await bootShell({ connect });
}, 20_000);

test("an edit carries the column count the grid draws", async () => {
  const fake = await opened(KEYS);
  await page.press("e", { ctrlKey: true });
  await page.clickCell(2, 1);
  await page.press("Enter");
  await page.setEditorValue("signup");
  await page.press("Enter");

  expect(await until(page, () => fake.edits.length === 1)).toBe(true);
  expect(fake.edits[0]).toEqual({ op: Op.Set, row: 2, col: 1, now: "signup", width: KEYS.length });
});

/** tabOver opens a workspace with no shell over a fake engine whose source has `columns`. */
async function tabOver(columns: ColumnInfo[]): Promise<[Workspace, FakeEngine]> {
  const fake = new FakeEngine(columns);
  const engine = new Engine(messagePort<Reply, Request>(fake));
  const ref = { name: FAKE_NAME, path: `/${FAKE_NAME}` };
  return [await Workspace.open(ref, engine, "", UNHEARD), fake];
}

test("a tab's saved cell on _file moves right with it, and one in a tab of no columns stays", async () => {
  const [w] = await tabOver(FILED);
  const [bare] = await tabOver([]);
  try {
    const tab = w.active;
    tab.cell = { row: ROW, col: KEYS.length };
    tab.widened(FILED_WIDE);
    bare.active.widened(KEYS);
    expect(tab.cell).toEqual({ row: ROW, col: KEYS.length + 1 });
    expect(tab.band.columns).toEqual(FILED_WIDE);
    expect(bare.active.cell, "a cell that named no column").toEqual({ row: 0, col: 0 });
  } finally {
    w.close();
    bare.close();
  }
});
