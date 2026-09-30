// The recent workspaces list: most recent first, kept between launches, and
// read as empty when the kept value is bad.

import { expect, test } from "vite-plus/test";

import { RECENTS_KEY, RECENTS_MAX, Recents } from "../src/renderer/recents.ts";
import { Kept } from "./kept.ts";

test("a workspace opened goes to the top, and is listed once", () => {
  const recents = new Recents(new Kept());
  recents.opened("/work/q3-close.uno");
  recents.opened("/work/liquidity.uno");
  recents.opened("/work/q3-close.uno");
  expect(recents.all).toEqual(["/work/q3-close.uno", "/work/liquidity.uno"]);
});

test("the list is kept, so the next launch reads it", () => {
  const kept = new Kept();
  new Recents(kept).opened("/work/q3-close.uno");
  expect(new Recents(kept).all).toEqual(["/work/q3-close.uno"]);
});

test("a workspace forgotten leaves the list, and stays gone", () => {
  const kept = new Kept();
  const recents = new Recents(kept);
  recents.opened("/work/a.uno");
  recents.opened("/work/b.uno");
  recents.forget("/work/b.uno");
  expect(recents.all).toEqual(["/work/a.uno"]);
  expect(new Recents(kept).all).toEqual(["/work/a.uno"]);
});

test("the list holds no more than its most, dropping the one opened longest ago", () => {
  const recents = new Recents(new Kept());
  for (let i = 0; i <= RECENTS_MAX; i++) recents.opened(`/work/${i}.uno`);
  expect(recents.all.length).toBe(RECENTS_MAX);
  expect(recents.all[0]).toBe(`/work/${RECENTS_MAX}.uno`);
  expect(recents.all).not.toContain("/work/0.uno");
});

test.each([
  ["nothing a list", '{"path":"/work/a.uno"}'],
  ["not JSON", "[/work/a.uno"],
])("a kept value that is %s reads as an empty list", (_what, value) => {
  const kept = new Kept();
  kept.setItem(RECENTS_KEY, value);
  expect(new Recents(kept).all).toEqual([]);
});

test("entries that are not paths are dropped, and the rest are kept", () => {
  const kept = new Kept();
  kept.setItem(RECENTS_KEY, JSON.stringify(["/work/a.uno", 7, "", "/work/a.uno", "/work/b.uno"]));
  expect(new Recents(kept).all).toEqual(["/work/a.uno", "/work/b.uno"]);
});
