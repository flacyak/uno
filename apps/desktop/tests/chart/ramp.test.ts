/**
 * @fileoverview The classes a heatmap wears an amount in: four equal steps
 * from zero up and four down, a round width, whole for counts, the largest
 * value always in the last, each value in the class whose break it reaches,
 * and as round for fewer, as a horizon chart's bands; and their legend.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { CLASSES, SWATCH_WIDE, classOf, classesOver, scaleOf, wear } from "@renderer/chart/ramp";
import { RAMP_SHARES } from "@renderer/theme";

test("as many classes stand either side of zero as the ramp has steps", () => {
  expect(CLASSES).toBe(RAMP_SHARES.length);
});

test("counts up to 7 class in steps of 2, each up to its break", () => {
  const classes = classesOver([0, 1, 2, 3, 7], true);
  expect(classes).toStrictEqual({ width: 2, breaks: [2, 4, 6, 8] });
  expect([1, 2, 3, 4, 5, 7, 8].map((v) => classOf(v, classes))).toEqual([1, 1, 2, 2, 3, 4, 4]);
});

test("counts of 1 or 2 class in whole steps", () => {
  expect(classesOver([1], true).breaks).toEqual([1, 2, 3, 4]);
  expect(classesOver([2, 1], true).breaks).toEqual([1, 2, 3, 4]);
  expect(classesOver([1], false).breaks).toEqual([0.25, 0.5, 0.75, 1]);
});

test("sums either side of zero share one width, set by the one furthest from zero", () => {
  const classes = classesOver([-0.3, 1.1, 0.25], false);
  expect(classes.breaks).toEqual([0.3, 0.6, 0.9, 1.2]);
  expect([-0.3, 1.1, 0.25, -2].map((v) => classOf(v, classes))).toEqual([-1, 4, 1, -4]);
  expect(classesOver([-900, 10], false).breaks).toEqual([250, 500, 750, 1000]);
  expect(classesOver([-6.4, 11], false).breaks).toEqual([3, 6, 9, 12]);
});

test("the value furthest from zero always lands in the last class, at any size", () => {
  for (let most = 1; most <= 2_000; most++) {
    for (const scale of [1e-3, 1, 1e6]) {
      const value = most * scale;
      expect(classOf(value, classesOver([value], false)), `${value}`).toBe(CLASSES);
    }
  }
  // 100 rows a day class in steps of 25, where a step of 50 would leave two classes unworn.
  expect(classesOver([100, 4], true).breaks).toEqual([25, 50, 75, 100]);
});

test("a value on a break stays in the class under it, however a double writes it", () => {
  const classes = classesOver([0.4], false);
  // 3 tenths is written exactly, though 3 * 0.1 is 0.30000000000000004.
  expect(classes.breaks).toEqual([0.1, 0.2, 0.3, 0.4]);
  const tenths = [0.1, 0.2, 0.1 + 0.2, 0.3, 0.4];
  expect(tenths.map((v) => classOf(v, classes))).toEqual([1, 2, 3, 3, 4]);
});

test("zero is in no class either way, and a scale of zeros is one wide", () => {
  const classes = classesOver([0, 0], false);
  expect(classes.width).toBe(1);
  expect(classOf(0, classes)).toBe(0);
  expect(classesOver([], true).width).toBe(1);
});

/** A tick's character, in px, and a legend's room in the least window. */
const CH = 7;
const LEGEND_NARROW = 160;

/** What a legend draws: each swatch's fill, and each break written with where it stands. */
function legendOf(drawn: HTMLElement): { fills: string[]; breaks: string[] } {
  const fills = [...drawn.querySelectorAll<HTMLElement>(".chart-swatch")].map((s) =>
    s.style.getPropertyValue("--fill"),
  );
  const breaks = [...drawn.querySelectorAll<HTMLElement>(".chart-tick")].map(
    (t) => `${t.textContent} at ${t.style.getPropertyValue("--at")}`,
  );
  return { fills, breaks };
}

test("a legend keys each class above zero, least first, with every break it has room for", () => {
  const classes = classesOver([7], true);
  const roomy = legendOf(scaleOf(classes, false, 1_000, CH));
  expect(roomy.fills).toEqual(["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)"]);
  expect(roomy.breaks).toEqual(["0 at 0", "2 at 1", "4 at 2", "6 at 3", "8 at 4"]);
  const wide = legendOf(scaleOf(classesOver([2_000], true), false, 1_000, CH));
  // 1,000 centred on its edge would touch 2,000 at the legend's end.
  expect(wide.breaks).toEqual(["0 at 0", "2,000 at 4"]);
});

test("a signed legend keys the pole's classes below zero, then the accent's, and in little room the ends and zero", () => {
  const classes = classesOver([-1_200, 2_000], false);
  const drawn = scaleOf(classes, true, LEGEND_NARROW, CH);
  const { fills, breaks } = legendOf(drawn);
  expect(fills).toEqual([
    "var(--div-4)",
    "var(--div-3)",
    "var(--div-2)",
    "var(--div-1)",
    "var(--seq-1)",
    "var(--seq-2)",
    "var(--seq-3)",
    "var(--seq-4)",
  ]);
  expect(breaks).toEqual(["-2,000 at 0", "0 at 4", "2,000 at 8"]);
  // Eight swatches share 160 px, and in plenty of room stand SWATCH_WIDE.
  expect(drawn.style.getPropertyValue("--swatch")).toBe("20px");
  const roomy = scaleOf(classes, true, 1_000, CH);
  expect(roomy.style.getPropertyValue("--swatch")).toBe(`${SWATCH_WIDE}px`);
});

/** Fewer classes than the ramp has steps, as a horizon chart's three bands. */
const BANDS = 3;

test("a scale of fewer classes steps as round, and its legend wears the fills it is given and writes zero", () => {
  // 5 over three classes rounds up to 2, so the last class reaches 6.
  const classes = classesOver([5, 1], true, BANDS);
  expect(classes).toStrictEqual({ width: 2, breaks: [2, 4, 6] });
  const fill = (step: number) => `step ${step}`;
  const { fills, breaks } = legendOf(scaleOf(classes, false, LEGEND_NARROW, CH, fill));
  expect(fills).toEqual(["step 1", "step 2", "step 3"]);
  expect(breaks).toEqual(["0 at 0", "2 at 1", "4 at 2", "6 at 3"]);
  // Every other break of seven would leave zero out, so a signed legend writes each, or the ends and zero.
  const signed = legendOf(scaleOf(classesOver([600], true, BANDS), true, LEGEND_NARROW, CH));
  expect(signed.breaks).toEqual(["-600 at 0", "0 at 3", "600 at 6"]);
});

test("a mark wears its class's colour and its class, which chart.css hatches where no colour reads, and at zero neither", () => {
  const [up, down, zero] = [3, -2, 0].map((step) => {
    const mark = document.createElement("span");
    wear(mark, step);
    return [
      mark.className,
      mark.style.getPropertyValue("--fill"),
      mark.style.getPropertyValue("--step"),
    ];
  });
  expect(up).toStrictEqual(["chart-stepped", "var(--seq-3)", "3"]);
  expect(down).toStrictEqual(["chart-stepped", "var(--div-2)", "-2"]);
  expect(zero).toStrictEqual(["", "", ""]);
  const swatches = [
    ...scaleOf(classesOver([-4, 4], true), true, 200, 7).querySelectorAll<HTMLElement>(
      ".chart-swatch",
    ),
  ];
  expect(swatches.map((s) => s.style.getPropertyValue("--step"))).toStrictEqual([
    "-4",
    "-3",
    "-2",
    "-1",
    "1",
    "2",
    "3",
    "4",
  ]);
});
