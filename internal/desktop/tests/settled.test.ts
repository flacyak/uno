// The window getting the focus asks the buckets once it has kept it: a burst
// of focus events asks once, and one while an ask is out asks nothing more.

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { settled } from "../src/renderer/shell/util.ts";

const MS = 400;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("a burst of triggers runs once, after they stop", async () => {
  let runs = 0;
  const trigger = settled(MS, () => {
    runs++;
    return Promise.resolve();
  });
  for (let i = 0; i < 5; i++) {
    trigger();
    await vi.advanceTimersByTimeAsync(MS / 4);
  }
  expect(runs, "still triggering").toBe(0);
  await vi.advanceTimersByTimeAsync(MS);
  expect(runs).toBe(1);
});

test("a trigger while a run is out does not start a second", async () => {
  let runs = 0;
  let finish: () => void = () => {};
  const trigger = settled(MS, () => {
    runs++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  trigger();
  await vi.advanceTimersByTimeAsync(MS);
  expect(runs).toBe(1);
  trigger();
  await vi.advanceTimersByTimeAsync(MS);
  expect(runs, "the first is still out").toBe(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  trigger();
  await vi.advanceTimersByTimeAsync(MS);
  expect(runs).toBe(2);
});
