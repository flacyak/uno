/**
 * @fileoverview The Refresher's timing: a source is checked at once, then at
 * the shortest interval among its charts, until no chart schedules it; one
 * still indexing waits until it is ready; a check that comes due while one
 * is out is skipped; a wake checks each overdue source once, however many
 * intervals it slept through; and failed checks, among them one with no
 * answer in time, whose source waits for its answer, back off up to a cap,
 * until a refresh by hand, which also ends a wait on the source's bucket.
 * Each source's checks say when the last ended, what it found and when the
 * next is due, and one with no answer in time says it failed until its answer
 * comes.
 */

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { NoAnswer, Refresher } from "@renderer/refresh";
import type { Refreshed } from "@renderer/refresh";
import { BACKOFF_CAP_MS, CHECK_TIMEOUT_MS } from "@renderer/timing";

/** One chart's schedule of every 5 min, and another's three times as long. */
const EVERY_MS = 300_000;
const LONGER = 3;

/** The cap on a backed-off wait, in intervals. */
const CAPPED = BACKOFF_CAP_MS / EVERY_MS;

/** The wait after one failed check, in intervals: the interval doubled. */
const BACKED_OFF = 2;

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
  await vi.advanceTimersByTimeAsync(0);
  refresher.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(LONGER * EVERY_MS);
  expect(checked).toStrictEqual(["a", "b"]);
});

test("failed checks back off, doubling up to the cap, and a success resets them", async () => {
  const at: number[] = [];
  let fails = true;
  refresher = new Refresher(() => {
    at.push(Date.now());
    return fails ? Promise.reject(new Error("refused")) : Promise.resolve(SAME);
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(LONGER * BACKOFF_CAP_MS);
  fails = false;
  await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS);
  const gaps = at.slice(1).map((t, i) => (t - at[i]!) / EVERY_MS);
  expect(gaps.slice(0, 6)).toStrictEqual([2, 4, 8, CAPPED, CAPPED, 1]);
});

test("a refresh by hand forgets the failures, and the next check is an interval after it", async () => {
  refresher = new Refresher((source) => {
    checked.push(source);
    return Promise.reject(new Error("refused"));
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(0);
  refresher.refreshed("a");
  await vi.advanceTimersByTimeAsync(EVERY_MS);
  expect(checked, "checked an interval after the refresh by hand").toHaveLength(2);
});

test("a source waiting on its bucket is checked an interval after a read by hand", async () => {
  let answer: Refreshed = { t: "waiting", why: "unconnected" };
  refresher = new Refresher((source) => {
    checked.push(source);
    return Promise.resolve(answer);
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(0);
  answer = SAME;
  refresher.refreshed("a");
  await vi.advanceTimersByTimeAsync(EVERY_MS);
  expect(checked, "checked an interval after the read by hand").toHaveLength(2);
});

test("a check with no answer in time fails, and the next waits for its answer, then backs off", async () => {
  let answer = (): void => {};
  refresher = new Refresher((source) => {
    checked.push(source);
    return new Promise((resolve) => (answer = () => resolve(SAME)));
  });
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + BACKOFF_CAP_MS);
  expect(checked, "no second check beside the one still out").toHaveLength(1);
  answer();
  await vi.advanceTimersByTimeAsync(EVERY_MS);
  expect(checked, "backed off from the check that timed out").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(EVERY_MS);
  expect(checked).toHaveLength(2);
});

test("a check with no answer in time says it failed until its answer comes, then what it found", async () => {
  let answer = (): void => {};
  refresher = new Refresher(
    () => new Promise((resolve) => (answer = () => resolve({ t: "read" }))),
  );
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
  const unanswered = { t: "failed", error: expect.any(NoAnswer) };
  expect(refresher.checks("a")).toStrictEqual({
    at: Date.now(),
    found: unanswered,
    next: undefined,
  });
  answer();
  await vi.advanceTimersByTimeAsync(0);
  expect(refresher.checks("a")?.found).toStrictEqual({ t: "read" });
});

test("a source's checks say when the last ended, what it found and when the next is due", async () => {
  const told: string[] = [];
  refresher = new Refresher(
    () => Promise.resolve(SAME),
    (source) => told.push(source),
  );
  expect(refresher.checks("a"), "never checked").toBeUndefined();
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(0);
  const at = Date.now();
  expect(refresher.checks("a")).toStrictEqual({ at, found: SAME, next: at + EVERY_MS });
  expect(told).toStrictEqual(["a"]);
});

test("a failed check says what failed it, and its next try waits out the backoff", async () => {
  const refused = new Error("refused");
  refresher = new Refresher(() => Promise.reject(refused));
  refresher.plan([{ source: "a", everyMs: EVERY_MS }]);
  await vi.advanceTimersByTimeAsync(0);
  const at = Date.now();
  const found = { t: "failed", error: refused };
  expect(refresher.checks("a")).toStrictEqual({ at, found, next: at + BACKED_OFF * EVERY_MS });
});

test("a read by hand of a source no chart schedules says it read, with no next check", () => {
  const told: string[] = [];
  refresher = new Refresher(
    () => Promise.resolve(SAME),
    (source) => told.push(source),
  );
  refresher.refreshed("a");
  const found = { t: "read" };
  expect(refresher.checks("a")).toStrictEqual({ at: Date.now(), found, next: undefined });
  expect(told).toStrictEqual(["a"]);
});
