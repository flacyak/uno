// The grid: a table that holds only the rows you can see.
//
// A 4,812-row export is about forty elements in the DOM, and scrolling moves
// them rather than making more. That is the same trade the Go build makes with
// widget.Table, and it is why what the grid reads has to stay a cache read: it
// calls `display` once per visible cell on every frame, so anything done there
// beyond reading an array is work multiplied by two hundred and then by sixty.
//
// It draws a Sheet or a band of rows from an engine through `Rows`, and cannot
// tell which. A row the band has not received yet is drawn pending and filled
// in when it lands. Nothing here waits.

import type { Kind } from "@uno/grid/sheet";

import { LOCKED, NOTHING, interpret, leavesInsert } from "./keys.ts";
import type { Action, Caret, Mode, Motion, Pending } from "./keys.ts";

/** Rows drawn beyond the viewport, so a fast scroll does not show a gap before
 * the next frame catches up. */
const OVERSCAN = 6;

/**
 * The tallest the scroller's content is allowed to be.
 *
 * Browsers stop laying out past a limit -- about 33.5 million pixels in
 * Chromium, less in Firefox -- so a sheet taller than this scrolls by
 * proportion: the scrollbar maps onto the rows, and the wheel and the keys still
 * move by rows.
 */
const MAX_SCROLL_PX = 15_000_000;

/**
 * Rows is what the grid draws. A Sheet is one, and so is an engine's band.
 *
 * The two optional methods are the band's. A Sheet has every row, so it has
 * nothing to say about which have arrived or what is on screen.
 */
export interface Rows {
  readonly columns: readonly { header: string; kind: Kind; flagged: boolean }[];
  rows(): number;
  cols(): number;
  display(row: number, col: number): string;
  raw(row: number, col: number): string;
  binding(col: number): string | undefined;
  ready?(row: number): boolean;
  view?(first: number, count: number): void;
}

export interface GridEvents {
  /** The selection moved, so the status bar can say where it is. */
  onSelect(row: number, col: number): void;
  /** A cell was committed. The sheet has already been told; this is for
   * everything that follows from an edit. */
  onEdit(row: number, col: number, value: string): void;
  /** A key has something to say: why it did nothing, or nothing, to clear the line. */
  onSay(text: string, isError: boolean): void;
  /** A key asked for the other mode. The shell switches, then shows the rows again. */
  onMode(to: Mode): void;
  /** The editor opened or closed, so the status bar can say INSERT. */
  onEditor(open: boolean): void;
  /** A key the grid cannot carry out itself, because the workspace does. */
  onAction(action: ShellAction): void;
}

/** The actions that belong to the shell rather than the grid. */
export type ShellAction = Extract<Action, { t: "undo" }>;

export class Grid {
  private source: Rows | undefined;
  private editable = false;

  private readonly scroller: HTMLElement;
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

  private selRow = 0;
  private selCol = 0;
  private editor: HTMLInputElement | undefined;
  private pending: Pending = NOTHING;

  private rowHeight = 29;
  private frame = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: GridEvents,
  ) {
    this.scroller = el("div", "grid-scroll");
    this.sizer = el("div", "grid-sizer");
    this.table = document.createElement("table");
    this.table.className = "grid";
    this.head = this.table.createTHead();
    this.body = this.table.createTBody();

    this.sizer.append(this.table);
    this.scroller.append(this.sizer);
    this.host.append(this.scroller);

    // Scrolling is the hot path, so it schedules a frame rather than laying out
    // synchronously on every one of the events a trackpad produces.
    this.scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.scroller.addEventListener("click", (e) => this.onClick(e));
    this.scroller.addEventListener("dblclick", () => this.beginEdit("all"));
    this.host.addEventListener("keydown", (e) => this.onKey(e));

    this.rowHeight = readRowHeight(this.scroller);
  }

  /**
   * Show rows, or nothing. `keep` holds the selection and the scroll position,
   * for the same rows drawn from somewhere else -- a band handing over to a
   * sheet when a file enters transform.
   */
  show(source: Rows | undefined, editable: boolean, keep = false): void {
    this.cancelEdit();
    this.source = source;
    this.editable = editable;
    this.pending = NOTHING;
    if (!keep) {
      this.selRow = 0;
      this.selCol = 0;
      this.top = 0;
      this.scroller.scrollTop = 0;
      this.seen = 0;
    }
    this.pool = [];
    this.body.replaceChildren();
    this.buildHead();
    this.layout();
  }

  /** Redraw what is on screen. Called when an edit lands, because a bound column
   * anywhere in view may have recomputed. */
  refresh(): void {
    this.buildHead();
    this.layout();
  }

  /** Redraw the body on the next frame: rows arrived, or the row count moved. */
  repaint(): void {
    this.schedule();
  }

  selection(): { row: number; col: number } {
    return { row: this.selRow, col: this.selCol };
  }

  /** moveTo selects a cell and brings it into view, as a key would. */
  moveTo(row: number, col: number): void {
    this.select(row, col);
  }

  /** Whether the cell editor is open: vim's insert mode. */
  editing(): boolean {
    return this.editor !== undefined;
  }

  focus(): void {
    this.host.focus();
  }

  private schedule(): void {
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
  private layout(): void {
    const source = this.source;
    if (source === undefined) {
      this.sizer.style.height = "0px";
      return;
    }

    const total = source.rows();
    const headH = this.head.offsetHeight;
    const viewport = this.scroller.clientHeight;
    const m = this.measure(total, headH, viewport);

    const height = `${m.real}px`;
    if (this.sizer.style.height !== height) this.sizer.style.height = height;
    this.scale(m.scaled);

    // Below the cap the scroller is the truth. Above it, only a scroll the grid
    // did not cause -- the scrollbar dragged -- moves the view to match it.
    const scrollTop = Math.max(0, this.scroller.scrollTop);
    if (!this.scaled || Math.abs(scrollTop - this.seen) >= 0.5) {
      this.top = m.rMax === 0 ? 0 : (scrollTop / m.rMax) * m.vMax;
    }
    this.top = Math.min(Math.max(0, this.top), m.vMax);
    this.seen = scrollTop;
    if (this.scaled) this.syncScroll(m.vMax, m.rMax);

    const digits = String(total).length;
    if (digits !== this.digits) {
      this.digits = digits;
      this.table.style.setProperty("--gutter-digits", String(digits));
    }

    const visible = Math.min(total, Math.ceil(viewport / this.rowHeight) + OVERSCAN);

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

    const maxFirst = Math.max(0, total - this.pool.length);
    const first = Math.min(maxFirst, Math.floor(this.top / this.rowHeight));
    this.first = first;

    // The table is moved as one element rather than each row being positioned,
    // so a scroll is one style write and not forty. It sits as far above the
    // scroller's top as the view is past row `first`, which below the cap is
    // exactly where row `first` is.
    //
    // It moves by `top` and not by a transform. A sticky header is placed from
    // the table's layout box, which a transform does not move, so past the
    // table's own height the header stuck to where the table had been and
    // scrolled out of sight. Whole pixels, because at millions of pixels down a
    // fraction draws the text blurred.
    this.offset = Math.round(this.seen - (this.top - first * this.rowHeight));
    const top = `${this.offset}px`;
    if (this.table.style.top !== top) this.table.style.top = top;

    source.view?.(first, this.pool.length);
    for (let i = 0; i < this.pool.length; i++) {
      this.paint(this.pool[i]!, first + i, source);
    }

    this.placeEditor();
  }

  private measure(
    total: number,
    headH: number,
    viewport: number,
  ): { real: number; scaled: boolean; vMax: number; rMax: number } {
    const virtual = total * this.rowHeight + headH;
    const real = Math.min(virtual, MAX_SCROLL_PX);
    return {
      real,
      scaled: virtual > MAX_SCROLL_PX,
      vMax: Math.max(0, virtual - viewport),
      rMax: Math.max(0, real - viewport),
    };
  }

  /** syncScroll puts the scrollbar where the view is, for a sheet above the cap. */
  private syncScroll(vMax: number, rMax: number): void {
    const want = vMax === 0 ? 0 : (this.top / vMax) * rMax;
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
  private paint(tr: HTMLTableRowElement, row: number, source: Rows): void {
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

      const selected = row === this.selRow && col === this.selCol;
      const cls = className(source.columns[col]!.kind, selected);
      if (td.className !== cls) td.className = cls;
    }
  }

  // ------------------------------------------------------------ interaction

  private onClick(e: MouseEvent): void {
    const td = (e.target as HTMLElement).closest("td");
    const tr = td?.closest("tr");
    if (td === null || td === undefined || tr === null || tr === undefined) return;
    if (td.classList.contains("gutter")) return;

    const col = Array.prototype.indexOf.call(tr.children, td) - 1;
    const row = this.first + Array.prototype.indexOf.call(this.body.children, tr);
    this.select(row, col);
  }

  private select(row: number, col: number): void {
    const source = this.source;
    if (source === undefined) return;

    this.cancelEdit();
    this.selRow = Math.max(0, Math.min(source.rows() - 1, row));
    this.selCol = Math.max(0, Math.min(source.cols() - 1, col));
    this.scrollIntoView();
    this.layout();
    this.events.onSelect(this.selRow, this.selCol);
  }

  private scrollIntoView(): void {
    const headH = this.head.offsetHeight;
    const top = this.selRow * this.rowHeight;
    const height = this.scroller.clientHeight - headH;

    if (top < this.top) this.top = top;
    else if (top + this.rowHeight > this.top + height) this.top = top + this.rowHeight - height;
    else return;

    if (!this.scaled) {
      this.scroller.scrollTop = this.top;
      return;
    }
    const m = this.measure(this.source?.rows() ?? 0, headH, this.scroller.clientHeight);
    this.syncScroll(m.vMax, m.rMax);
  }

  /**
   * onKey hands a key to keys.ts and carries out what it means.
   *
   * Every key the grid takes is prevented, so a letter that opens the editor is
   * not typed into it as well.
   */
  private onKey(e: KeyboardEvent): void {
    if (this.source === undefined) return;
    if (this.editor !== undefined) return; // the editor has its own keys

    const step = interpret(this.editable ? "transform" : "view", this.pending, {
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      repeat: e.repeat,
    });
    if (step === undefined) return;
    e.preventDefault();
    this.pending = step.pending;
    this.act(step.action);
  }

  private act(action: Action): void {
    switch (action.t) {
      case "none":
        return;
      case "move":
        this.move(action.motion);
        return;
      case "mode":
        this.events.onMode(action.to);
        return;
      case "insert":
        // a in view: the switch writes nothing and was asked for, so it happens
        // even when the editor then refuses the cell.
        if (action.transform) this.events.onMode("transform");
        this.beginEdit(action.caret);
        return;
      case "say":
        this.events.onSay(action.text, false);
        return;
      default:
        this.events.onAction(action);
    }
  }

  private move(motion: Motion): void {
    const source = this.source;
    if (source === undefined) return;
    switch (motion) {
      case "down":
        return this.select(this.selRow + 1, this.selCol);
      case "up":
        return this.select(this.selRow - 1, this.selCol);
      case "right":
        return this.select(this.selRow, this.selCol + 1);
      case "left":
        return this.select(this.selRow, this.selCol - 1);
      case "page-down":
        return this.select(this.selRow + this.page(), this.selCol);
      case "page-up":
        return this.select(this.selRow - this.page(), this.selCol);
      case "home":
        return this.select(0, 0);
      case "end":
        return this.select(source.rows() - 1, source.cols() - 1);
    }
  }

  private page(): number {
    return Math.max(1, Math.floor(this.scroller.clientHeight / this.rowHeight) - 1);
  }

  // ---------------------------------------------------------------- editing

  /**
   * beginEdit opens an entry over the selected cell.
   *
   * It starts from `raw` and not `display`, because what a person edits is what
   * the cell stores. Editing what it shows would mean typing over the result of
   * a computation, which the sheet refuses anyway -- and refusing after the
   * typing is a worse way to say so than not offering it.
   */
  private beginEdit(caret: Caret): void {
    const source = this.source;
    if (source === undefined || this.editor !== undefined) return;

    // In view a keystroke changes nothing, and says what would.
    if (!this.editable) {
      this.events.onSay(LOCKED, false);
      return;
    }
    const refused = this.refusal(source);
    if (refused !== "") {
      this.events.onSay(refused, true);
      return;
    }

    const input = document.createElement("input");
    input.className = "cell-editor";
    input.value = caret === "empty" ? "" : source.raw(this.selRow, this.selCol);

    input.addEventListener("keydown", (e) => {
      // Swallowed first, before anything that could fail. Stopping propagation
      // at the end of the handler meant that any throw on the way -- or any
      // early return added later -- let the same Enter reach the grid, which
      // read it as "start editing" and opened a second editor over the cell
      // that had just been committed.
      e.stopPropagation();

      // Esc keeps the typing, as Enter and blur do. Vim users press it at the end
      // of every insert, and losing the text each time would make the keys
      // useless. A value that did not change records nothing.
      if (leavesInsert(e.key, e.isComposing)) {
        e.preventDefault();
        this.commitEdit();
      }
    });
    input.addEventListener("blur", () => this.commitEdit());

    this.editor = input;
    this.sizer.append(input);
    this.placeEditor();
    input.focus();
    if (caret === "all") input.select();
    else {
      const at = caret === "start" ? 0 : input.value.length;
      input.setSelectionRange(at, at);
    }
    this.events.onEditor(true);
  }

  /**
   * refusal says why the selected cell cannot be written, or "" when it can.
   *
   * A row the band has not received has no value here. An editor opened on it
   * would start from "", and appending to that would write over the real cell.
   */
  private refusal(source: Rows): string {
    if (source.rows() === 0) return "no rows";
    // A derived column stores nothing to type over. The sheet would refuse it;
    // saying so before the keystroke is kinder than after it.
    if (source.binding(this.selCol) !== undefined) {
      return `${source.columns[this.selCol]?.header ?? "this column"} is computed from a formula · nothing to type over`;
    }
    if (source.ready?.(this.selRow) === false) {
      return `row ${(this.selRow + 1).toLocaleString()} is still loading`;
    }
    return "";
  }

  private placeEditor(): void {
    const input = this.editor;
    if (input === undefined) return;

    const td = this.cellElement(this.selRow, this.selCol);
    if (td === undefined) {
      // The cell being edited scrolled out of view. Keeping the entry where the
      // cell was would leave it floating over a different row.
      this.cancelEdit();
      return;
    }

    input.style.left = `${td.offsetLeft}px`;
    input.style.top = `${td.offsetTop + this.offset}px`;
    input.style.width = `${td.offsetWidth}px`;
    input.style.height = `${td.offsetHeight}px`;
  }

  private cellElement(row: number, col: number): HTMLTableCellElement | undefined {
    const tr = this.body.children[row - this.first];
    if (tr === undefined) return undefined;
    return tr.children[col + 1] as HTMLTableCellElement | undefined;
  }

  private commitEdit(): void {
    const input = this.editor;
    const source = this.source;
    if (input === undefined || source === undefined) return;

    const value = input.value;
    this.cancelEdit();

    if (value !== source.raw(this.selRow, this.selCol)) {
      this.events.onEdit(this.selRow, this.selCol, value);
    }
    this.focus();
    this.layout();
  }

  private cancelEdit(): void {
    const input = this.editor;
    if (input === undefined) return;
    // Cleared before the input goes, so a blur fired by removing it finds no
    // editor to commit a second time.
    this.editor = undefined;
    input.remove();
    this.events.onEditor(false);
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
