/**
 * @fileoverview A bar a pointer carries by its label to another place among
 * its plot's bars, with a line where it will land. It starts only on a row's
 * label, so the window's own drag, which starts only on its head, its grip
 * and its edges, never meets it.
 */

import { el } from "@renderer/shell/util";
import { BAR_GAP, VALUE_ROWS } from "./rows.ts";

/** The button a person drags with. */
const PRIMARY_BUTTON = 0;

/** The pointer a finger is, which never carries a bar: a bar moves under a mouse or a pen. */
const TOUCH = "touch";

/** How far a pointer goes up or down before a press on a label carries the bar, in px. */
export const CARRY_AFTER = 4;

/** A pointer that pressed the label of the row `from` at `y`, and where its bar lands once it carries it. */
type Carry = { pointer: number; from: number; y: number; to?: number };

/** landing gives where among `rows` a bar from `from` lands with the pointer at `y`. */
export function landing(rows: readonly DOMRect[], from: number, y: number): number {
  const gap = rows.filter((row) => (row.top + row.bottom) / 2 < y).length;
  return gap > from ? gap - 1 : gap;
}

/**
 * BarDrag carries a bar of `plot` by its row's label while `movable` says
 * the plot's bars move, and hands `moved` where it lands.
 */
export class BarDrag {
  private carry: Carry | undefined;
  /** The line between two rows where the bar will land. */
  private readonly line = el("div", "chart-landing");

  constructor(
    private readonly plot: HTMLElement,
    private readonly movable: () => boolean,
    private readonly moved: (from: number, to: number) => void,
  ) {
    plot.addEventListener("pointerdown", (e) => this.press(e));
    plot.addEventListener("pointermove", (e) => this.follow(e));
    plot.addEventListener("pointerup", (e) => this.drop(e));
    plot.addEventListener("pointercancel", () => this.end());
  }

  /** press takes the pointer that pressed a row's label, which carries the bar once it moves. */
  private press(e: PointerEvent): void {
    const label = e.target instanceof Element ? e.target.closest(".chart-bar-label") : null;
    if (e.button !== PRIMARY_BUTTON || e.pointerType === TOUCH || label === null || !this.movable())
      return;
    const from = [...this.plot.querySelectorAll(VALUE_ROWS)].findIndex((row) =>
      row.contains(label),
    );
    if (from === -1) return;
    this.plot.setPointerCapture(e.pointerId);
    this.carry = { pointer: e.pointerId, from, y: e.clientY };
  }

  /** follow stands the line where the carried bar would land. */
  private follow(e: PointerEvent): void {
    const carry = this.carry;
    if (carry?.pointer !== e.pointerId) return;
    if (carry.to === undefined && Math.abs(e.clientY - carry.y) < CARRY_AFTER) return;
    const rows = [...this.plot.querySelectorAll(VALUE_ROWS)].map((row) =>
      row.getBoundingClientRect(),
    );
    carry.to = landing(rows, carry.from, e.clientY);
    // The line stands in the middle of the gap the bar lands in, as wide as the rows.
    const gap = rows.filter((row) => (row.top + row.bottom) / 2 < e.clientY).length;
    const half = BAR_GAP / 2;
    const at = gap < rows.length ? rows[gap]!.top - half : rows.at(-1)!.bottom + half;
    const plot = this.plot.getBoundingClientRect();
    this.line.style.setProperty("--at", `${at - plot.top}px`);
    this.line.style.setProperty("--left", `${rows[0]!.left - plot.left}px`);
    this.line.style.setProperty("--width", `${rows[0]!.width}px`);
    this.plot.classList.add("carrying");
    this.plot.append(this.line);
  }

  /** drop hands where the bar landed, and lets go. */
  private drop(e: PointerEvent): void {
    const carry = this.carry;
    if (carry?.pointer !== e.pointerId) return;
    this.end();
    if (carry.to !== undefined && carry.to !== carry.from) this.moved(carry.from, carry.to);
  }

  /** end lets go of the pointer, and takes the line away. */
  private end(): void {
    this.carry = undefined;
    this.line.remove();
    this.plot.classList.remove("carrying");
  }
}
