/**
 * @fileoverview A source whose columns grow while it is indexed, drawn by the
 * real shell over a fake engine. Each edit carries the column count the grid
 * draws.
 *
 * @vitest-environment happy-dom
 */

import { beforeAll, expect, test } from "vite-plus/test";

import type { ColumnInfo, MessagePortLike } from "@engine";
import type { Shell } from "@renderer/shell/shell";
import { Op } from "@sheet";
import { FAKE_NAME, FakeEngine, cellAt } from "./fake-engine.ts";
import { bootShell } from "./smoke/dom-harness.ts";
import { domPage, until } from "./smoke/dom-page.ts";

/** The columns the source's first lines hold. */
const KEYS: ColumnInfo[] = [
  { header: "id", kind: "num", flagged: false },
  { header: "event", kind: "text", flagged: false },
  { header: "page", kind: "text", flagged: false },
];

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
