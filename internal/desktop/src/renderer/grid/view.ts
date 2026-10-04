// The view: a virtualised table that holds only the rows on screen.
//
// A pool of about forty row elements is reused as the view scrolls. Each
// frame calls `display` once per visible cell, so `display` must be cheap.
//
// Rows are virtualised and columns are drawn in full: every pooled row holds
// a cell per column. A frame writes only the cells whose text changed.

import type { Kind } from "@uno/grid/sheet";

import { m } from "../../paraglide/messages.js";
import { num } from "../locale.ts";
import {
  clampTop,
  firstRow,
  intoView,
  spanIntoView,
  measure,
  pageSize,
  fitPool,
  poolSize,
  scrollerToTop,
  scrollTarget,
  tableOffset,
  topToScroller,
  visibleRange,
} from "./metrics.ts";
import { el } from "../shell/util.ts";
import { columnLabel, unnamed } from "./rows.ts";
import type { Cell, Rows } from "./rows.ts";

export class View {
  /** The rows being drawn, or undefined. */
  source: Rows | undefined;

  readonly scroller: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly head: HTMLTableSectionElement;
  private readonly body: HTMLTableSectionElement;

  /** Row elements, one per visible line, reused as the view scrolls. */
  private pool: HTMLTableRowElement[] = [];
  private first = 0;
  /** The table's current `top` offset within the sizer. */
  private offset = 0;

  /**
   * View position in pixels on the uncapped sheet.
   *
   * On an unscaled sheet this equals the scroller's scrollTop. On a scaled
   * sheet it is tracked here, since scrollTop is too coarse to hold a one-row
   * step.
   */
  private top = 0;
  /** The scrollTop last read or set by layout. Used to detect scrollbar
   * drags while scaled. */
  private seen = 0;
  private scaled = false;
  private digits = 0;
  private readonly onWheel = (e: WheelEvent): void => this.wheel(e);

  private readonly rowHeight: number;
  private frame = 0;

  constructor(
    host: HTMLElement,
    /** Returns the selected cell. */
    private readonly selected: () => Cell,
    /** Called after every layout. */
    private readonly laidOut: () => void,
  ) {
    this.scroller = el("div", "grid-scroll");
    this.sizer = el("div", "grid-sizer");
    this.table = el("table");
    this.table.className = "grid";
    this.head = this.table.createTHead();
    this.body = this.table.createTBody();

    this.sizer.append(this.table);
    this.scroller.append(this.sizer);
    host.append(this.scroller);

    // Scroll events coalesce into one layout per animation frame.
    this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    // The pool size depends on the scroller's height.
    new ResizeObserver(() => this.schedule()).observe(this.scroller);

    this.rowHeight = readRowHeight(this.scroller);
  }

  /** Draws `source`, or clears the view. `keep` preserves the scroll
   * position. */
  show(source: Rows | undefined, keep: boolean): void {
    this.source = source;
    if (!keep) {
      this.top = 0;
      this.scroller.scrollTop = 0;
      // Along the row too: a fresh open starts at the first cell, and the
      // selection is placed there directly, so the view must already show it.
      this.scroller.scrollLeft = 0;
      this.seen = 0;
    }
    this.pool = [];
    this.body.replaceChildren();
    this.refresh();
  }

  /** Redraws the header and the visible rows. */
  refresh(): void {
    this.buildHead();
    this.layout();
  }

  /** Runs layout on the next animation frame. Repeated calls coalesce. */
  schedule(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  /**
   * Draws the header row. Each column shows its name, a kind badge (flagged
   * when the column holds formatted numbers that read as text), and an "fx"
   * badge when a formula computes it.
   */
  private buildHead(): void {
    this.head.replaceChildren();
    if (this.source === undefined) return;

    const tr = el("tr");
    tr.append(el("th", "gutter"));

    for (const [col, column] of this.source.columns.entries()) {
      const wrap = el("span", "colhead");
      // A blank header is named by its position and styled as unnamed.
      const cls = unnamed(column.header) ? "colname unnamed" : "colname";
      wrap.append(el("span", cls, columnLabel(column.header, col)));

      // Formula badge, with the formula as its tooltip.
      const binding = this.source.binding(col);
      if (binding !== undefined) {
        const fx = el("span", "badge bound", "fx");
        fx.title = `= ${binding}`;
        wrap.append(fx);
      }

      const badge = el("span", column.flagged ? "badge flagged" : "badge", column.kind);
      if (column.flagged) badge.title = m.column_flagged_hint();
      wrap.append(badge);

      const th = el("th");
      th.append(wrap);
      tr.append(th);
    }
    this.head.append(tr);
  }

  /**
   * Lays out the visible rows. Sizes the pool, positions the table, and
   * paints each pooled row. Scrolling reuses the pooled elements as they
   * are.
   */
  layout(): void {
    const source = this.source;
    if (source === undefined) {
      this.sizer.style.height = "0px";
      return;
    }

    const total = source.rows();
    const headH = this.head.offsetHeight;
    const viewport = this.scroller.clientHeight;
    const m = measure(total, this.rowHeight, headH, viewport);

    const height = `${m.real}px`;
    if (this.sizer.style.height !== height) this.sizer.style.height = height;
    this.scale(m.scaled);

    // On an unscaled sheet, scrollTop is the view position. On a scaled sheet,
    // only a scrollTop change from outside this class (a scrollbar drag)
    // moves it.
    const scrollTop = Math.max(0, this.scroller.scrollTop);
    if (!this.scaled || Math.abs(scrollTop - this.seen) >= 0.5) {
      this.top = scrollerToTop(scrollTop, m.rMax, m.vMax);
    }
    this.top = clampTop(this.top, m.vMax);
    this.seen = scrollTop;
    if (this.scaled) this.syncScroll(m.vMax, m.rMax);

    // Gutter width follows the digit count of the formatted row total.
    const digits = num(total).length;
    if (digits !== this.digits) {
      this.digits = digits;
      this.table.style.setProperty("--gutter-digits", String(digits));
    }

    const visible = poolSize(total, viewport, this.rowHeight);

    fitPool(this.pool, visible, () => blankRow(source.cols()), this.body);

    const first = firstRow(total, this.pool.length, this.top, this.rowHeight);
    this.first = first;

    // The whole table is positioned once per frame with `top`, which moves
    // the table's layout box. The sticky header is placed from that box, so
    // it follows.
    this.offset = tableOffset(this.seen, this.top, first, this.rowHeight);
    const top = `${this.offset}px`;
    if (this.table.style.top !== top) this.table.style.top = top;

    source.view?.(first, this.pool.length);
    const selected = this.selected();
    for (let i = 0; i < this.pool.length; i++) {
      this.paint(this.pool[i]!, first + i, source, selected);
    }

    this.laidOut();
  }

  /** Sets scrollTop to match `top` on a scaled sheet. */
  private syncScroll(vMax: number, rMax: number): void {
    const want = topToScroller(this.top, vMax, rMax);
    if (Math.abs(want - this.scroller.scrollTop) >= 1) this.scroller.scrollTop = want;
    this.seen = this.scroller.scrollTop;
  }

  /**
   * Adds the wheel listener when the sheet becomes scaled and removes it
   * when the sheet returns to normal size. The listener is non-passive, so
   * it is attached only while scaled.
   */
  private scale(on: boolean): void {
    if (on === this.scaled) return;
    this.scaled = on;
    if (on) this.scroller.addEventListener("wheel", this.onWheel, { passive: false });
    else this.scroller.removeEventListener("wheel", this.onWheel);
  }

  private wheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // Ctrl+wheel is zoom
    e.preventDefault();
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? this.rowHeight
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? this.scroller.clientHeight
          : 1;
    this.top += e.deltaY * unit;
    this.scroller.scrollLeft += e.deltaX * unit;
    this.schedule();
  }

  /** Writes one row's text and classes, touching only what changed. */
  private paint(tr: HTMLTableRowElement, row: number, source: Rows, sel: Cell): void {
    const ready = source.ready?.(row) ?? true;
    const even = row % 2 === 1;
    const cls = ready ? (even ? "even" : "") : even ? "even pending" : "pending";
    if (tr.className !== cls) tr.className = cls;

    const cells = tr.children;
    const gutter = cells[0] as HTMLTableCellElement;
    // Row number, locale-formatted.
    const label = num(row + 1);
    if (gutter.textContent !== label) gutter.textContent = label;

    for (let col = 0; col < source.cols(); col++) {
      const td = cells[col + 1] as HTMLTableCellElement | undefined;
      if (td === undefined) continue;

      const value = ready ? source.display(row, col) : "";
      if (td.textContent !== value) td.textContent = value;

      const selected = row === sel.row && col === sel.col;
      const cls = className(source.columns[col]!.kind, selected);
      if (td.className !== cls) td.className = cls;
    }
  }

  /** Returns the cell containing `target`, or undefined for the gutter and
   * the header. */
  cellAt(target: HTMLElement): Cell | undefined {
    const td = target.closest("td");
    const tr = td?.closest("tr");
    if (td === null || td === undefined || tr === null || tr === undefined) return undefined;
    if (td.classList.contains("gutter")) return undefined;

    const col = Array.prototype.indexOf.call(tr.children, td) - 1;
    const row = this.first + Array.prototype.indexOf.call(this.body.children, tr);
    return { row, col };
  }

  /** Scrolls the least amount needed to show the whole cell, vertically and
   * horizontally. */
  scrollIntoView(row: number, col: number): void {
    const want = intoView(row, this.rowHeight, this.top, this.bodyHeight());
    if (want !== undefined) this.scrollTo(want);

    // The header cell gives the column's position for every row, drawn or
    // pending.
    const th = this.head.firstElementChild?.children[col + 1];
    if (!(th instanceof HTMLElement)) return;
    // Column 0 scrolls to include the gutter.
    const start = col === 0 ? 0 : th.offsetLeft;
    const size = th.offsetLeft + th.offsetWidth - start;
    const { scrollLeft, clientWidth } = this.scroller;
    const left = spanIntoView(start, size, scrollLeft, clientWidth);
    if (left !== undefined) this.scroller.scrollLeft = left;
  }

  /** Scrolls so `row` sits at the top, middle or bottom of the screen. The
   * selection stays where it is. */
  scrollRow(row: number, where: "top" | "middle" | "bottom"): void {
    this.scrollTo(scrollTarget(row, this.rowHeight, this.bodyHeight(), where));
    this.layout();
  }

  /** Moves the view to `top`, in pixels on the uncapped sheet. */
  private scrollTo(top: number): void {
    const headH = this.head.offsetHeight;
    const m = measure(this.source?.rows() ?? 0, this.rowHeight, headH, this.scroller.clientHeight);
    this.top = clampTop(top, m.vMax);
    if (this.scaled) this.syncScroll(m.vMax, m.rMax);
    else this.scroller.scrollTop = this.top;
  }

  /** Viewport height minus the header. */
  private bodyHeight(): number {
    return this.scroller.clientHeight - this.head.offsetHeight;
  }

  /** First and last rows fully on screen. */
  visibleRows(): { top: number; bottom: number } {
    return visibleRange(this.top, this.rowHeight, this.bodyHeight(), this.source?.rows() ?? 0);
  }

  /** Rows moved by one page. */
  page(): number {
    return pageSize(this.scroller.clientHeight, this.rowHeight);
  }

  /** Positions `node` over a cell. Returns false for a cell outside the
   * pooled rows. */
  place(node: HTMLElement, row: number, col: number): boolean {
    const td = this.cellElement(row, col);
    if (td === undefined) return false;
    node.style.left = `${td.offsetLeft}px`;
    node.style.top = `${td.offsetTop + this.offset}px`;
    node.style.width = `${td.offsetWidth}px`;
    node.style.height = `${td.offsetHeight}px`;
    return true;
  }

  /** Appends `node` to the scrolled content, where `place` can position it. */
  hold(node: HTMLElement): void {
    this.sizer.append(node);
  }

  private cellElement(row: number, col: number): HTMLTableCellElement | undefined {
    const tr = this.body.children[row - this.first];
    if (tr === undefined) return undefined;
    return tr.children[col + 1] as HTMLTableCellElement | undefined;
  }
}

function className(kind: Kind, selected: boolean): string {
  const numeric = kind === "num" ? "num" : "";
  if (selected) return numeric === "" ? "sel" : "num sel";
  return numeric;
}

/** Reads the `--row-h` CSS variable. Falls back to 29. */
function readRowHeight(scope: Element): number {
  const declared = getComputedStyle(scope).getPropertyValue("--row-h").trim();
  const parsed = Number.parseFloat(declared);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 29;
}

/** Creates an empty row: a gutter cell, then one cell per column. */
function blankRow(cols: number): HTMLTableRowElement {
  const tr = el("tr");
  tr.append(el("td", "gutter"));
  for (let c = 0; c < cols; c++) tr.append(el("td"));
  return tr;
}
