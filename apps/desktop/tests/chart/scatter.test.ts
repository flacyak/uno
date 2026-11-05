/**
 * @fileoverview A scatter chart drawn from a tally: a point per sampled row,
 * where its x and y stand between the first and last ticks of axes that take
 * in every plotted row, over a gridline at each tick, and each tick's label on
 * its gridline. The x axis writes its labels in full under a million, and
 * compactly where they stand too close. A sample that draws fewer points than
 * it plotted rows says so, in the language chosen.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Sample } from "@engine";
import { baseLocale, setLocale } from "@paraglide/runtime";
import { axis } from "@renderer/chart/axes";
import { POINT_RADIUS, TICK_GAP, fitAlong, sampled, scatter } from "@renderer/chart/scatter";

/** A tally that sent `x` and `y` and plotted no other row. */
function sampleOf(x: number[], y: number[]): Sample {
  const least = { x: Math.min(...x), y: Math.min(...y) };
  const most = { x: Math.max(...x), y: Math.max(...y) };
  return { x, y, plotted: x.length, least, most, skipped: { blank: 0, unparsed: 0 } };
}

/** Units against revenue: x ticks 0 to 200 by 50, and y 0 to 4,000 by 1,000. */
const SALES = sampleOf([0, 50, 200], [0, 3000, 4000]);

afterEach(() => {
  vi.restoreAllMocks();
  void setLocale(baseLocale, { reload: false });
});

/** Revenue against itself, ticked 0 to 150,000 by 50,000 both ways. */
const WIDE = sampleOf([0, 150_000], [0, 150_000]);

/** WIDE's labels along x in full, and up y as compact() writes them. */
const ALONG = ["0", "50,000", "100,000", "150,000"];
const UP = ["0", "50K", "100K", "150K"];

/** How wide a label's character is laid out, in px: 11 px mono's ch, rounded up. */
const CH = 7;

/** The attribute `name` of each of `box`'s `selector`. */
const read = (box: HTMLElement, selector: string, name: string): Array<string | null> =>
  [...box.querySelectorAll(selector)].map((at) => at.getAttribute(name));

/** `box`'s labels of the `side` axis, least first. */
const labels = (box: HTMLElement, side: "x" | "y"): HTMLElement[] => [
  ...box.querySelectorAll<HTMLElement>(`.chart-ticks.${side} .chart-tick`),
];

test("a point stands where its x and y fall between each axis's first tick and its last", () => {
  const box = scatter(SALES);
  expect(read(box, ".chart-point", "cx")).toStrictEqual(["0%", "25%", "100%"]);
  expect(read(box, ".chart-point", "cy")).toStrictEqual(["100%", "25%", "0%"]);
  expect(read(box, ".chart-point", "r")).toStrictEqual(SALES.x.map(() => `${POINT_RADIUS}`));
});

test("the axes take in every plotted row, not only the rows the tally sent", () => {
  const sent = { ...sampleOf([50], [1000]), plotted: 4812 };
  const box = scatter({ ...sent, least: { x: -100, y: 0 }, most: { x: 100, y: 4000 } });
  expect(read(box, ".chart-point", "cx")).toStrictEqual(["75%"]);
  expect(read(box, ".chart-point", "cy")).toStrictEqual(["75%"]);
});

test("a gridline crosses the plot at each tick of either axis, under the points", () => {
  const box = scatter(SALES);
  const ticks = ["0%", "25%", "50%", "75%", "100%"];
  expect(read(box, ".chart-grid.x", "x1")).toStrictEqual(ticks);
  expect(read(box, ".chart-grid.x", "y2")).toStrictEqual(ticks.map(() => "100%"));
  expect(read(box, ".chart-grid.y", "y1")).toStrictEqual(ticks.toReversed());
  expect(read(box, ".chart-grid.y", "x2")).toStrictEqual(ticks.map(() => "100%"));
  expect(box.querySelector(".chart-grid ~ .chart-point")).not.toBeNull();
  expect(box.querySelector(".chart-point ~ .chart-grid")).toBeNull();
});

test("each tick's label stands on its gridline, y's in a gutter of the widest and x's under the plot", () => {
  const box = scatter(SALES);
  const [y, x] = [labels(box, "y"), labels(box, "x")];
  expect(y.map((at) => at.textContent)).toStrictEqual(["0", "1,000", "2,000", "3,000", "4,000"]);
  expect(y.map((at) => at.style.top)).toStrictEqual(read(box, ".chart-grid.y", "y1"));
  expect(x.map((at) => at.textContent)).toStrictEqual(["0", "50", "100", "150", "200"]);
  expect(x.map((at) => at.style.left)).toStrictEqual(read(box, ".chart-grid.x", "x1"));
  // The last x label reaches half its length past the points, and the first before them.
  const room = (name: string): string => box.style.getPropertyValue(name);
  expect(["--gutter", "--x-first", "--x-last"].map(room)).toStrictEqual(["5ch", "0.5ch", "1.5ch"]);
});

test("an x axis under a million writes its labels in full, where the y axis compacts from 10,000", () => {
  const box = scatter(WIDE);
  expect(labels(box, "x").map((at) => at.textContent)).toStrictEqual(ALONG);
  expect(labels(box, "y").map((at) => at.textContent)).toStrictEqual(UP);
});

test("an x axis whose labels in full stand under TICK_GAP apart writes them compactly, as y does", () => {
  // Lays out WIDE's x labels as a page would, `apart` px from middle to middle, and fits them.
  const fitted = (apart: number, width: number): HTMLElement => {
    const box = scatter(WIDE);
    for (const [i, label] of labels(box, "x").entries()) {
      const at = new DOMRect(i * apart - width / 2, 0, width);
      Object.defineProperty(label, "getBoundingClientRect", { value: () => at });
    }
    fitAlong(box, WIDE);
    return box;
  };
  const said = (box: HTMLElement): Array<string | null> =>
    labels(box, "x").map((at) => at.textContent);
  const width = 40;
  expect(said(fitted(width + TICK_GAP, width))).toStrictEqual(ALONG);
  const crowded = fitted(width + TICK_GAP - 1, width);
  expect(said(crowded)).toStrictEqual(UP);
  expect(crowded.style.getPropertyValue("--x-last")).toBe("2ch");
  expect(labels(crowded, "x").map((at) => at.style.left)).toStrictEqual(
    read(crowded, ".chart-grid.x", "x1"),
  );
  // A plot not laid out yet keeps its labels, to fit them once it is.
  expect(said(fitted(0, 0))).toStrictEqual(ALONG);
});

test("an x axis whose labels crowd even compactly labels every second tick, or fewer, over every gridline", () => {
  // 1,050,000 reads 1.1M compactly, so these ticks stay in full.
  const near = sampleOf([900_000, 1_050_000], [0, 1]);
  const ticks = ["900,000", "950,000", "1,000,000", "1,050,000"] as const;
  // Lays each label out as a page would, centred on its tick, `apart` px from the next tick.
  const fitted = (apart: number): HTMLElement => {
    const wide = apart * (ticks.length - 1);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.textContent!.length * CH;
        return new DOMRect((parseFloat(this.style.left) / 100) * wide - width / 2, 0, width);
      },
    );
    const box = scatter(near);
    fitAlong(box, near);
    return box;
  };
  const said = (box: HTMLElement): Array<string | null> =>
    labels(box, "x").map((at) => at.textContent);
  // How far apart the middles of labels `a` and `b` stand where the two touch.
  const touching = (a: string, b: string): number => ((a.length + b.length) / 2) * CH;
  const [first, second, third, last] = ticks;
  // The widest two stand TICK_GAP apart, and every other two further.
  expect(said(fitted(touching(third, last) + TICK_GAP))).toStrictEqual(ticks);
  // The first two touch, and every second tick's labels stand two ticks apart.
  const thinned = fitted(touching(first, second));
  expect(said(thinned)).toStrictEqual([first, third]);
  expect(labels(thinned, "x").map((at) => at.style.left)).toStrictEqual(
    read(thinned, ".chart-grid.x", "x1").filter((_, i) => i % 2 === 0),
  );
  // Every second tick's labels touch too, so only the first is written.
  expect(said(fitted(touching(first, third) / 2))).toStrictEqual([first]);
});

test("a sample says how many of its plotted rows it draws, in the language chosen, and nothing where it draws every one", () => {
  const plotted = { ...SALES, plotted: 4808 };
  expect(sampled(SALES)).toBe("");
  expect(sampled(plotted)).toBe("3 of 4,808 points");
  // A sampled row with a blank or a word sends no point, so a sample can send none.
  expect(sampled({ ...SALES, x: [], y: [], plotted: 1 })).toBe("0 of 1 point");
  void setLocale("pt-BR", { reload: false });
  expect(sampled(plotted)).toBe("3 de 4.808 pontos");
});

test("a tally that plotted nothing draws nothing, as its extent of 0 is no row's", () => {
  const none = { ...sampleOf([0], [0]), x: [], y: [], plotted: 0 };
  expect(scatter(none).childElementCount).toBe(0);
});

test("an axis no double can scale draws nothing, where its points would stand at NaN", () => {
  // A span past what a double holds gives no ticks to scale by.
  const wide = sampleOf([-9e307, 9e307], [0, 1]);
  expect(axis(wide.least.x, wide.most.x).ticks.length).toBeLessThan(2);
  expect(scatter(wide).childElementCount).toBe(0);
  // Ticks a double holds can still lie further apart than one does.
  const far = sampleOf([-8e307, 8e307], [0, 1]);
  expect(axis(far.least.x, far.most.x).ticks.every(Number.isFinite)).toBe(true);
  expect(scatter(far).childElementCount).toBe(0);
});
