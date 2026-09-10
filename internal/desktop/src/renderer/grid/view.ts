// The view: a table that holds only the rows you can see.
//
// A 4,812-row export is about forty elements in the DOM, and scrolling moves
// them rather than making more. That is the same trade the Go build makes with
// widget.Table, and it is why what the grid reads has to stay a cache read: it
// calls `display` once per visible cell on every frame, so anything done there
// beyond reading an array is work multiplied by two hundred and then by sixty.

import type { Kind } from "@uno/grid/sheet";

import {
  clampTop,
  firstRow,
  intoView,
  measure,
  pageSize,
  poolSize,
  scrollerToTop,
  scrollTarget,
  tableOffset,
  topToScroller,
  visibleRange,
} from "./metrics.ts";
import type { Cell, Rows } from "./rows.ts";

export class View {
  /** What is drawn, or nothing. */
  source: Rows | undefined;

  readonly scroller: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly head: HTMLTableSectionElement;
  private readonly body: HTMLTableSectionElement;

  /** The pool. One row element per visible line, reused as the view moves. */
  private pool: HTMLTableRowElement[] = [];
  private first = 0;
  /** How far down the table is translated, for the editor to sit over a cell. */
  private offset = 0;

  /**
   * How far down the sheet the view is, in pixels of a sheet nothing capped.
   *
   * Below the cap this is the scroller's scrollTop. Above it, it is kept here,
   * because at many rows to a pixel, reading scrollTop back would round a
   * one-row step to nothing.
   */
  private top = 0;
  /** The scrollTop the grid last saw or set, so a scroll it did not cause stands out. */
  private seen = 0;
  private scaled = false;
  private digits = 0;
  private readonly onWheel = (e: WheelEvent): void => this.wheel(e);

  private readonly rowHeight: number;
  private frame = 0;

  constructor(
    host: HTMLElement,
    /** The selected cell, which paint marks. */
    private readonly selected: () => Cell,
    /** Called after every layout, so what sits over a cell can follow it. */
    private readonly laidOut: () => void,
  ) {
    this.scroller = el("div", "grid-scroll");
    this.sizer = el("div", "grid-sizer");
    this.table = document.createElement("table");
    this.table.className = "grid";
    this.head = this.table.createTHead();
    this.body = this.table.createTBody();

    this.sizer.append(this.table);
    this.scroller.append(this.sizer);
    host.append(this.scroller);

    // Scrolling is the hot path, so it schedules a frame rather than laying out
    // synchronously on every one of the events a trackpad produces.
    this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true });

    this.rowHeight = readRowHeight(this.scroller);
  }

  /**
   * show draws rows, or nothing. `keep` holds the scroll position, for the same
   * rows drawn from somewhere else.
   */
  show(source: Rows | undefined, keep: boolean): void {
    this.source = source;
    if (!keep) {
      this.top = 0;
      this.scroller.scrollTop = 0;
      this.seen = 0;
    }
    this.pool = [];
    this.body.replaceChildren();
    this.refresh();
  }

  /** refresh redraws the header and the rows on screen. */
  refresh(): void {
    this.buildHead();
    this.layout();
  }

  /** schedule lays out on the next frame, once however often it is asked. */
  schedule(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  /**
   * buildHead draws the header, which is the one place a column's inferred kind
   * is visible: the badge says what uno thinks the column is, and says it in
   * amber when the column looks numeric and does not parse.
   */
  private buildHead(): void {
    this.head.replaceChildren();
    if (this.source === undefined) return;

    const tr = document.createElement("tr");
    tr.append(el("th", "gutter"));

    for (const column of this.source.columns) {
      const th = document.createElement("th");
      const wrap = el("span", "colhead");
      wrap.append(text(column.header));

      const badge = el("span", column.flagged ? "badge flagged" : "badge");
      badge.textContent = column.kind;
      // The flag is the recogniser's opening: numeric data wearing a costume.
      if (column.flagged) badge.title = "looks numeric, does not parse";
      wrap.append(badge);

      th.append(wrap);
      tr.append(th);
    }
    this.head.append(tr);
  }

  /**
   * layout is the whole virtualiser.
   *
   * It decides which rows are visible, makes exactly that many row elements
   * once, and from then on only writes text into them. No element is created or
   * destroyed while a person scrolls.
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

    // Below the cap the scroller is the truth. Above it, only a scroll the grid
    // did not cause -- the scrollbar dragged -- moves the view to match it.
    const scrollTop = Math.max(0, this.scroller.scrollTop);
    if (!this.scaled || Math.abs(scrollTop - this.seen) >= 0.5) {
      this.top = scrollerToTop(scrollTop, m.rMax, m.vMax);
    }
    this.top = clampTop(this.top, m.vMax);
    this.seen = scrollTop;
    if (this.scaled) this.syncScroll(m.vMax, m.rMax);

    const digits = String(total).length;
    if (digits !== this.digits) {
      this.digits = digits;
      this.table.style.setProperty("--gutter-digits", String(digits));
    }

    const visible = poolSize(total, viewport, this.rowHeight);

    // Grow or shrink the pool. This runs on a resize and on the first draw, and
    // not while scrolling.
    while (this.pool.length < visible) {
      const tr = document.createElement("tr");
      tr.append(el("td", "gutter"));
      for (let c = 0; c < source.cols(); c++) tr.append(document.createElement("td"));
      this.pool.push(tr);
      this.body.append(tr);
    }
    while (this.pool.length > visible) this.pool.pop()?.remove();

    const first = firstRow(total, this.pool.length, this.top, this.rowHeight);
    this.first = first;

    // The table is moved as one element rather than each row being positioned,
    // so a scroll is one style write and not forty. It sits as far above the
    // scroller's top as the view is past row `first`, which below the cap is
    // exactly where row `first` is.
    //
    // It moves by `top` and not by a transform. A sticky header is placed from
    // the table's layout box, which a transform does not move, so past the
    // table's own height the header stuck to where the table had been and
    // scrolled out of sight.
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

  /** syncScroll puts the scrollbar where the view is, for a sheet above the cap. */
  private syncScroll(vMax: number, rMax: number): void {
    const want = topToScroller(this.top, vMax, rMax);
    if (Math.abs(want - this.scroller.scrollTop) >= 1) this.scroller.scrollTop = want;
    this.seen = this.scroller.scrollTop;
  }

  /**
   * scale turns the grid's own wheel handling on above the cap and off below it.
   * A wheel listener that can cancel sends every scroll through script first, so
   * it is only there while the grid has to move by rows itself.
   */
  private scale(on: boolean): void {
    if (on === this.scaled) return;
    this.scaled = on;
    if (on) this.scroller.addEventListener("wheel", this.onWheel, { passive: false });
    else this.scroller.removeEventListener("wheel", this.onWheel);
  }

  private wheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // a pinch is a zoom, and belongs to the browser
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

  /** paint writes one row. Every read here is `display`, which is a cache read. */
  private paint(tr: HTMLTableRowElement, row: number, source: Rows, sel: Cell): void {
    const ready = source.ready?.(row) ?? true;
    const even = row % 2 === 1;
    const cls = ready ? (even ? "even" : "") : even ? "even pending" : "pending";
    if (tr.className !== cls) tr.className = cls;

    const cells = tr.children;
    const gutter = cells[0] as HTMLTableCellElement;
    const label = String(row + 1);
    if (gutter.textContent !== label) gutter.textContent = label;

    for (let col = 0; col < source.cols(); col++) {
      const td = cells[col + 1] as HTMLTableCellElement | undefined;
      if (td === undefined) continue;

      const value = ready ? source.display(row, col) : "";
      // Writing textContent unconditionally would dirty every cell on every
      // frame; most of them have not changed.
      if (td.textContent !== value) td.textContent = value;

      const selected = row === sel.row && col === sel.col;
      const cls = className(source.columns[col]!.kind, selected);
      if (td.className !== cls) td.className = cls;
    }
  }

  /** cellAt is the cell a click landed in, or undefined for the gutter and the header. */
  cellAt(target: HTMLElement): Cell | undefined {
    const td = target.closest("td");
    const tr = td?.closest("tr");
    if (td === null || td === undefined || tr === null || tr === undefined) return undefined;
    if (td.classList.contains("gutter")) return undefined;

    const col = Array.prototype.indexOf.call(tr.children, td) - 1;
    const row = this.first + Array.prototype.indexOf.call(this.body.children, tr);
    return { row, col };
  }

  /** scrollIntoView scrolls as little as puts a row wholly on screen. */
  scrollIntoView(row: number): void {
    const want = intoView(row, this.rowHeight, this.top, this.bodyHeight());
    if (want !== undefined) this.scrollTo(want);
  }

  /**
   * scrollRow puts a row at the top, middle or bottom of the screen and leaves
   * the selection where it is. Near either end of the sheet the scroll clamps.
   */
  scrollRow(row: number, where: "top" | "middle" | "bottom"): void {
    this.scrollTo(scrollTarget(row, this.rowHeight, this.bodyHeight(), where));
    this.layout();
  }

  /**
   * scrollTo moves the view to `top`, in pixels of a sheet nothing capped. Above
   * the cap the scrollbar is put where that is, rather than read back.
   */
  private scrollTo(top: number): void {
    const headH = this.head.offsetHeight;
    const m = measure(this.source?.rows() ?? 0, this.rowHeight, headH, this.scroller.clientHeight);
    this.top = clampTop(top, m.vMax);
    if (this.scaled) this.syncScroll(m.vMax, m.rMax);
    else this.scroller.scrollTop = this.top;
  }

  /** The height the rows have on screen: the viewport, less the header over it. */
  private bodyHeight(): number {
    return this.scroller.clientHeight - this.head.offsetHeight;
  }

  /** The first and last rows wholly on screen, for H, M and L. */
  visibleRows(): { top: number; bottom: number } {
    return visibleRange(this.top, this.rowHeight, this.bodyHeight(), this.source?.rows() ?? 0);
  }

  /** page is how many rows a page moves: a screen, less one to keep in sight. */
  page(): number {
    return pageSize(this.scroller.clientHeight, this.rowHeight);
  }

  /**
   * place puts an element exactly over a cell, and says false when the cell is
   * not on screen to be put over.
   */
  place(node: HTMLElement, row: number, col: number): boolean {
    const td = this.cellElement(row, col);
    if (td === undefined) return false;
    node.style.left = `${td.offsetLeft}px`;
    node.style.top = `${td.offsetTop + this.offset}px`;
    node.style.width = `${td.offsetWidth}px`;
    node.style.height = `${td.offsetHeight}px`;
    return true;
  }

  /** hold puts an element in the scrolled content, where `place` positions it. */
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

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function text(value: string): Text {
  return document.createTextNode(value);
}

/** The row height lives in the stylesheet, so the virtualiser asks for it
 * rather than keeping a second copy that can disagree. */
function readRowHeight(scope: Element): number {
  const declared = getComputedStyle(scope).getPropertyValue("--row-h").trim();
  const parsed = Number.parseFloat(declared);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 29;
}
