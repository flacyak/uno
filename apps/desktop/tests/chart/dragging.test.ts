/**
 * @fileoverview A bar a pointer carries by its label: where it lands among
 * its plot's rows, and that a press that does not go far, or one off a label,
 * carries nothing.
 *
 * @vitest-environment happy-dom
 */

import { expect, test, vi } from "vite-plus/test";

import { BarDrag, CARRY_AFTER, landing } from "@renderer/chart/dragging";
import { el } from "@renderer/shell/util";

/** Four rows, each ROW px high, from the plot's top. */
const ROW = 26;
const COUNT = 4;
const rects = Array.from({ length: COUNT }, (_, i) => new DOMRect(0, i * ROW, 100, ROW - 2));

test.each<[number, number, number]>([
  [0, ROW * 1.6, 1],
  [0, ROW * 3.9, 3],
  [3, 0, 0],
  [2, ROW * 2.4, 2],
  [1, ROW * 0.4, 0],
])("a bar from %i dropped at %d px lands at %i", (from, y, to) => {
  expect(landing(rects, from, y)).toBe(to);
});

/** A plot of COUNT rows laid out as `rects`, each a label and a track, carried by a BarDrag. */
function carried(movable = true): { plot: HTMLElement; moved: ReturnType<typeof vi.fn> } {
  const plot = el("div", "chart-plot");
  for (const rect of rects) {
    const row = el("div", "chart-bar-row");
    row.append(el("bdi", "chart-bar-label", "v"), el("div", "chart-bar-track"));
    row.getBoundingClientRect = () => rect;
    plot.append(row);
  }
  plot.setPointerCapture = () => undefined;
  document.body.replaceChildren(plot);
  const moved = vi.fn();
  new BarDrag(plot, () => movable, moved);
  return { plot, moved };
}

const pointer = (type: string, at: Element, y: number, pointerType = "mouse") =>
  at.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, button: 0, clientY: y, pointerType, bubbles: true }),
  );

test("a press on a row's label carries its bar where the pointer drops it, with a line where it lands", () => {
  const { plot, moved } = carried();
  const label = plot.querySelectorAll(".chart-bar-label")[0]!;
  pointer("pointerdown", label, ROW / 2);
  pointer("pointermove", plot, ROW * 2.6);
  expect(plot.querySelector(".chart-landing")).not.toBeNull();
  pointer("pointerup", plot, ROW * 2.6);
  expect(moved).toHaveBeenCalledExactlyOnceWith(0, 2);
  expect(plot.querySelector(".chart-landing")).toBeNull();
});

test("a press that goes less than CARRY_AFTER px, one off a label, and one where bars do not move carry nothing", () => {
  const { plot, moved } = carried();
  const label = plot.querySelectorAll(".chart-bar-label")[1]!;
  pointer("pointerdown", label, ROW * 1.5);
  pointer("pointermove", plot, ROW * 1.5 + CARRY_AFTER - 1);
  pointer("pointerup", plot, ROW * 1.5 + CARRY_AFTER - 1);
  pointer("pointerdown", plot.querySelectorAll(".chart-bar-track")[1]!, ROW * 1.5);
  pointer("pointermove", plot, ROW * 3.5);
  pointer("pointerup", plot, ROW * 3.5);
  expect(moved).not.toHaveBeenCalled();
  const fixed = carried(false);
  pointer("pointerdown", fixed.plot.querySelector(".chart-bar-label")!, ROW / 2);
  pointer("pointermove", fixed.plot, ROW * 3.5);
  pointer("pointerup", fixed.plot, ROW * 3.5);
  expect(fixed.moved).not.toHaveBeenCalled();
});

test("a finger on a label carries nothing, as a bar moves under a mouse or a pen alone", () => {
  for (const pointerType of ["touch", "pen"]) {
    const { plot, moved } = carried();
    pointer("pointerdown", plot.querySelector(".chart-bar-label")!, ROW / 2, pointerType);
    pointer("pointermove", plot, ROW * 2.6, pointerType);
    pointer("pointerup", plot, ROW * 2.6, pointerType);
    expect(moved.mock.calls).toStrictEqual(pointerType === "pen" ? [[0, 2]] : []);
  }
});
