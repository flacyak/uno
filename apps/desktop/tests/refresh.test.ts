/**
 * @fileoverview The Refresher's timing: a source is checked at once, then at
 * the shortest interval among its charts.
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { Refresher } from "@renderer/refresh";

/** One chart's schedule of every 5 min, and another's three times as long. */
const EVERY_MS = 300_000;
const LONGER = 3;

let refresher: Refresher;
let checked: string[];

beforeEach(() => {
  vi.useFakeTimers();
  checked = [];
  refresher = new Refresher((source) => {
    checked.push(source);
    return Promise.resolve();
  });
});
afterEach(() => {
  vi.useRealTimers();
});

test("a source is checked at once, then at the shortest interval among its charts", async () => {
  refresher.plan([
    { source: "a", everyMs: LONGER * EVERY_MS },
    { source: "a", everyMs: EVERY_MS },
  ]);
  await vi.advanceTimersByTimeAsync(EVERY_MS - 1);
  expect(checked).toStrictEqual(["a"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(checked).toStrictEqual(["a", "a"]);
});
