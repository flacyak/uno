/**
 * @fileoverview A histogram's columns drawn from one level of its spread: a
 * slot per bin, its span filling the plot's width and the bins past it to
 * each side beyond its edges, in a scroller that first shows the span.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Level } from "@tally";
import { COLUMN_PITCH_LEAST } from "@renderer/chart/columns";
import { binTargets, binnedIn, histogram } from "@renderer/chart/histogram";
import { Tooltip } from "@renderer/chart/tooltip";
import type { Press } from "@renderer/keys";
import { el } from "@renderer/shell/util";
import { ROOM } from "../charted.ts";

/** Ten bins 10 wide from 0, the span the middle six: ticked 0 to 8 by 2. */
const TENS: Level = {
  step: 1,
  power: 1,
  first: 0,
  rows: [1, 0, 4, 8, 6, 2, 3, 2, 0, 1],
  at: 2,
  spans: 6,
  below: 0,
  above: 0,
};

/** A press of `key` alone, as keys.ts reads it. */
const pressed = (key: string): Press => ({
  key,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
  repeat: false,
});

/** A level of `spans` bins of one row, all of them its span. */
const flat = (spans: number, power: number): Level => ({
  ...TENS,
  power,
  rows: Array.from({ length: spans }, () => 1),
  at: 0,
  spans,
});

test("each bin has a slot, its column its rows' share of an axis from zero", () => {
  const box = histogram({ level: TENS, fits: true });
  const slots = [...box.querySelectorAll<HTMLElement>(".chart-periods > .chart-period")];
  const shares = slots.map((slot) => slot.style.getPropertyValue("--share"));
  expect(shares).toStrictEqual([
    "0.125",
    "0",
    "0.5",
    "1",
    "0.75",
    "0.25",
    "0.375",
    "0.25",
    "0",
    "0.125",
  ]);
  expect(box.querySelectorAll(".chart-period .chart-column")).toHaveLength(TENS.rows.length);
});

test("the span fills the scroller's width, and the bins past it stand beyond its edges", () => {
  const box = histogram({ level: TENS, fits: true });
  const along = box.querySelector<HTMLElement>(".chart-along")!;
  expect(along.classList.contains("chart-scrolls")).toBe(true);
  // A scroller takes no focus from the plot, which has the keys.
  expect(along.hasAttribute("tabindex")).toBe(false);
  const periods = along.querySelector<HTMLElement>(".chart-periods")!;
  expect(periods.style.width).toBe(`${(TENS.rows.length / TENS.spans) * 100}%`);
  expect(box.style.getPropertyValue("--span-at")).toBe(`${TENS.at / TENS.spans}`);
});

test("a histogram draws the finest level whose span's bins each get their least pitch", () => {
  const across = ROOM.width;
  const fine = flat(Math.ceil(across / COLUMN_PITCH_LEAST) + 1, 0);
  const coarse = flat(Math.floor(across / COLUMN_PITCH_LEAST / 2), 1);
  expect(binnedIn([fine, coarse], ROOM)).toStrictEqual({ level: coarse, fits: true });
  const narrow = { ...ROOM, width: COLUMN_PITCH_LEAST };
  expect(binnedIn([fine, coarse], narrow)).toStrictEqual({ level: coarse, fits: false });
  expect(binnedIn([], ROOM)).toBeUndefined();
});

test("a bin is worth its rows and their share, named by its edges to the decimals of its width", () => {
  const box = histogram({ level: TENS, fits: true });
  const numbers = TENS.rows.reduce((a, b) => a + b, 0);
  const said = (i: number) =>
    binTargets(TENS, numbers, box)
      .all[i]!.said()
      .map((r) => `${r.value} ${r.label.textContent}`)
      .join(" · ");
  expect(said(3)).toBe("8 30 to 40 · 30% share");
  const tenths = histogram({ level: { ...TENS, power: -1 }, fits: true });
  expect(
    binTargets({ ...TENS, power: -1 }, numbers, tenths).all[0]!.said()[0]!.label.textContent,
  ).toBe("0.0 to 0.1");
});

test("the keys reveal the mark they step to, and a pointer leaves the scroll as it is", () => {
  const box = histogram({ level: TENS, fits: true });
  const plot = el("div");
  plot.append(box);
  document.body.append(plot);
  const tip = new Tooltip(plot, document.body, "tip");
  const revealed: number[] = [];
  const targets = binTargets(TENS, 1, box);
  tip.show({
    ...targets,
    all: targets.all.map((t, i) => ({ ...t, reveal: () => revealed.push(i) })),
  });
  tip.step(pressed("End"));
  tip.step(pressed("ArrowLeft"));
  const slot = box.querySelectorAll(".chart-period")[2]!;
  slot.dispatchEvent(new PointerEvent("pointermove", { clientX: 1, clientY: 1, bubbles: true }));
  expect(revealed).toStrictEqual([TENS.rows.length - 1, TENS.rows.length - 2]);
  plot.remove();
});
