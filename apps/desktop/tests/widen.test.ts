/**
 * @fileoverview A source whose columns grow while it is indexed, drawn by the
 * real shell over a fake engine. A column found as the file is indexed gets a
 * header cell with its badge in the turn it arrives, the band is read again,
 * the selection and a tab's saved cell stay on their cell as _file moves
 * right, a tab that had no columns keeps its cell, and each edit carries the
 * column count the grid draws.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test } from "vite-plus/test";

import { Engine, messagePort } from "@engine";
import type { ColumnInfo, MessagePortLike, Reply, Request } from "@engine";
import { m } from "@paraglide/messages";
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
const WIDE = [...KEYS, LATE];

/** The source as the one part of a source that shows each row's file in _file. */
const FILE: ColumnInfo = { header: "_file", kind: "text", flagged: false };
const FILED = [...KEYS, FILE];
const FILED_WIDE = [...KEYS, LATE, FILE];

/** The row a saved cell or the selection is left on before the widen. */
const ROW = 2;
/** The column the selection is left on, and what the status bar says of its cell. */
const PAGE = KEYS.findIndex((column) => column.header === "page");
const PICKED = `${KEYS[PAGE]!.header} · row ${ROW + 1}`;

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

/** headers returns each header cell's name, and badges each's kind badge. */
function headers(): string[] {
  return [...document.querySelectorAll("thead th .colname")].map((n) => n.textContent ?? "");
}
function badges(): string[] {
  return [...document.querySelectorAll("thead th .badge")].map((b) => b.textContent ?? "");
}

/** rowsAsked counts the rows requests the engine has been sent. */
function rowsAsked(fake: FakeEngine): number {
  return fake.asked.filter((r) => r.t === "rows").length;
}

/** selected returns where the cell drawn as selected is among the drawn rows. */
function selected(): { row: number; col: number } | undefined {
  const td = document.querySelector("tbody td.sel");
  const tr = td?.parentElement;
  if (td === null || tr === null || tr === undefined) return undefined;
  const rows = [...document.querySelectorAll("tbody tr")];
  return { row: rows.indexOf(tr as HTMLTableRowElement), col: [...tr.children].indexOf(td) - 1 };
}

/** delivered resolves once a reply sent before it has been handed to the client. */
function delivered(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

test("a column found as the file is indexed is drawn with its badge in the turn it arrives, over rows read again", async () => {
  const fake = await opened(KEYS);
  await page.clickCell(ROW, PAGE);
  expect(await page.text("#status-cell")).toBe(PICKED);
  const asked = rowsAsked(fake);

  fake.widen(WIDE);
  await delivered();
  expect(headers(), "drawn before the next frame").toEqual(WIDE.map((c) => c.header));
  expect(badges()).toEqual(WIDE.map((c) => c.kind));
  expect(await page.text("#status-file")).toContain(m.columns_count({ count: WIDE.length }));
  const rows = await page.rows();
  expect(rows.every((r) => r.cells.length === WIDE.length)).toBe(true);

  expect(await page.until([{ row: ROW, col: KEYS.length, equals: cellAt(LATE, ROW) }])).toBe(true);
  expect(rowsAsked(fake), "rows built before the widen are stale").toBeGreaterThan(asked);
  expect(await page.text("#status-cell")).toBe(PICKED);
  expect(selected()).toEqual({ row: ROW, col: PAGE });
});

test("an edit after the widen is aimed among the columns drawn, and lands in the new one", async () => {
  const fake = await opened(KEYS);
  fake.widen(WIDE);
  expect(await page.until([{ row: ROW, col: KEYS.length, equals: cellAt(LATE, ROW) }])).toBe(true);

  await page.press("e", { ctrlKey: true });
  await page.clickCell(ROW, KEYS.length);
  await page.press("Enter");
  await page.setEditorValue("autumn-sale");
  await page.press("Enter");

  expect(await until(page, () => fake.edits.length === 1)).toBe(true);
  const edit = { op: Op.Set, row: ROW, col: KEYS.length, now: "autumn-sale", width: WIDE.length };
  expect(fake.edits[0]).toEqual(edit);
});

test("a selection on _file moves right with it as a column is found, and stays on its cell", async () => {
  const fake = await opened(FILED);
  await page.clickCell(ROW, KEYS.length);
  const onFile = `_file · row ${ROW + 1}`;
  expect(await page.text("#status-cell")).toBe(onFile);

  fake.widen(FILED_WIDE);
  await delivered();
  expect(headers()).toEqual(FILED_WIDE.map((c) => c.header));
  expect(await page.text("#status-cell")).toBe(onFile);
  expect(selected()).toEqual({ row: ROW, col: KEYS.length + 1 });
});

/** tabOver opens a workspace with no shell over a fake engine whose source has `columns`. */
async function tabOver(columns: ColumnInfo[]): Promise<[Workspace, FakeEngine]> {
  const fake = new FakeEngine(columns);
  const engine = new Engine(messagePort<Reply, Request>(fake));
  const ref = { name: FAKE_NAME, path: `/${FAKE_NAME}` };
  return [await Workspace.open(ref, engine, "", UNHEARD), fake];
}

test("a tab's saved cell on _file moves right with it, and one in a tab of no columns stays", async () => {
  const [w, fake] = await tabOver(FILED);
  const [bare, none] = await tabOver([]);
  try {
    const tab = w.active;
    tab.cell = { row: ROW, col: KEYS.length };
    fake.widen(FILED_WIDE);
    none.widen(KEYS);
    await delivered();
    expect(tab.cell).toEqual({ row: ROW, col: KEYS.length + 1 });
    expect(tab.band.columns).toEqual(FILED_WIDE);
    expect(bare.active.cell, "a cell that named no column").toEqual({ row: 0, col: 0 });
  } finally {
    w.close();
    bare.close();
  }
});
