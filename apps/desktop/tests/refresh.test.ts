/**
 * @fileoverview The Refresher's timing: a source is checked at once, then at
 * the shortest interval among its charts, until no chart schedules it; one
 * still indexing waits until it is ready; a check that comes due while one
 * is out is skipped; and a wake checks each overdue source once, however
 * many intervals it slept through.
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { Refresher } from "@renderer/refresh";
import type { Refreshed } from "@renderer/refresh";

/** One chart's schedule of every 5 min, and another's three times as long. */
const EVERY_MS = 300_000;
const LONGER = 3;

const SAME: Refreshed = { t: "same" };

let refresher: Refresher;
let checked: string[];

beforeEach(() => {
  vi.useFakeTimers();
  checked = [];
  refresher = new Refresher((source) => {
    checked.push(source);
    return Promise.resolve(SAME);
  });
});
afterEach(() => {
  refresher.dispose();
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

test("a wake while a check is out starts no second, and the next is due an interval after it ends", async () => {
  let finish: (done: Refreshed) => void = () => {};
  refresher = new Refresher((source) => {
    checked.push(source);
    return new Promise((resolve) => (finish = resolve));
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  refresher.wake();
  expect(checked, "the first is still out").toStrictEqual(["a"]);
  finish(SAME);
  await vi.advanceTimersByTimeAsync(EVERY_MS - 1);
  expect(checked).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(checked).toHaveLength(2);
});

test("a source still indexing is checked again once it is ready, not before", async () => {
  let answer: Refreshed = { t: "waiting", why: "indexing" };
  refresher = new Refresher((source) => {
    checked.push(source);
    return Promise.resolve(answer);
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(LONGER * EVERY_MS);
  expect(checked, "waiting on its index").toHaveLength(1);
  answer = SAME;
  refresher.ready("a");
  await vi.advanceTimersByTimeAsync(EVERY_MS);
  expect(checked).toHaveLength(3);
});

test("a wake after a sleep checks each overdue source once, and leaves one not yet due", async () => {
  refresher.plan([
    { source: "a", everyMs: EVERY_MS },
    { source: "b", everyMs: LONGER * LONGER * EVERY_MS },
  ]);
  await vi.advanceTimersByTimeAsync(0);
  // A sleep moves the wall clock on and fires no timer.
  vi.setSystemTime(Date.now() + LONGER * EVERY_MS);
  refresher.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(checked).toStrictEqual(["a", "b", "a"]);
});

test("a source no chart schedules is not checked again, and dispose stops the timer", async () => {
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  refresher.plan([{ source: "b", everyMs: EVERY_MS }]);
  refresher.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(LONGER * EVERY_MS);
  expect(checked).toStrictEqual(["a", "b"]);
});
