// The grid: a table that holds only the rows you can see.
//
// A 4,812-row export is about forty elements in the DOM, and scrolling moves
// them rather than making more. That is the same trade the Go build makes with
// widget.Table, and it is why `sheet.display` had to stay a cache read: this
// calls it once per visible cell on every frame, so anything it did beyond
// reading an array would be work multiplied by two hundred and then by sixty.

import type { Kind, Sheet } from "@uno/grid/sheet";

/** Rows drawn beyond the viewport, so a fast scroll does not show a gap before
 * the next frame catches up. */
const OVERSCAN = 6;

export interface GridEvents {
  /** The selection moved, so the status bar can say where it is. */
  onSelect(row: number, col: number): void;
  /** A cell was committed. The sheet has already been told; this is for
   * everything that follows from an edit. */
  onEdit(row: number, col: number, value: string): void;
}

export class Grid {
  private sheet: Sheet | undefined;
  private readonly scroller: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly head: HTMLTableSectionElement;
  private readonly body: HTMLTableSectionElement;

  /** The pool. One row element per visible line, reused as the view moves. */
  private rows: HTMLTableRowElement[] = [];
  private first = 0;

  private selRow = 0;
  private selCol = 0;
  private editor: HTMLInputElement | undefined;

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
    this.scroller.addEventListener("dblclick", () => this.beginEdit());
    this.host.addEventListener("keydown", (e) => this.onKey(e));

    this.rowHeight = readRowHeight(this.scroller);
  }

  /** Show a sheet, or nothing. */
  show(sheet: Sheet | undefined): void {
    this.cancelEdit();
    this.sheet = sheet;
    this.selRow = 0;
    this.selCol = 0;
    this.rows = [];
    this.body.replaceChildren();
    this.scroller.scrollTop = 0;
    this.buildHead();
    this.layout();
  }

  /** Redraw what is on screen. Called when an edit lands, because a bound column
   * anywhere in view may have recomputed. */
  refresh(): void {
    this.buildHead();
    this.layout();
  }

  selection(): { row: number; col: number } {
    return { row: this.selRow, col: this.selCol };
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
    if (this.sheet === undefined) return;

    const tr = document.createElement("tr");
    tr.append(el("th", "gutter"));

    for (const column of this.sheet.columns) {
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
    const sheet = this.sheet;
    if (sheet === undefined) {
      this.sizer.style.height = "0px";
      return;
    }

    const total = sheet.rows();
    const headH = this.head.offsetHeight;
    this.sizer.style.height = `${total * this.rowHeight + headH}px`;

    const viewport = this.scroller.clientHeight;
    const visible = Math.min(total, Math.ceil(viewport / this.rowHeight) + OVERSCAN);

    // Grow or shrink the pool. This runs on a resize and on the first draw, and
    // not while scrolling.
    while (this.rows.length < visible) {
      const tr = document.createElement("tr");
      tr.append(el("td", "gutter"));
      for (let c = 0; c < sheet.cols(); c++) tr.append(document.createElement("td"));
      this.rows.push(tr);
      this.body.append(tr);
    }
    while (this.rows.length > visible) this.rows.pop()?.remove();

    const maxFirst = Math.max(0, total - this.rows.length);
    const first = Math.min(
      maxFirst,
      Math.floor(Math.max(0, this.scroller.scrollTop) / this.rowHeight),
    );
    this.first = first;

    // The table is moved as one element rather than each row being positioned,
    // so a scroll is one style write and not forty.
    this.table.style.transform = `translateY(${first * this.rowHeight}px)`;

    for (let i = 0; i < this.rows.length; i++) {
      this.paint(this.rows[i]!, first + i, sheet);
    }

    this.placeEditor();
  }

  /** paint writes one row. Every read here is `display`, which is the cache. */
  private paint(tr: HTMLTableRowElement, row: number, sheet: Sheet): void {
    tr.className = row % 2 === 1 ? "even" : "";

    const cells = tr.children;
    const gutter = cells[0] as HTMLTableCellElement;
    const label = String(row + 1);
    if (gutter.textContent !== label) gutter.textContent = label;

    for (let col = 0; col < sheet.cols(); col++) {
      const td = cells[col + 1] as HTMLTableCellElement | undefined;
      if (td === undefined) continue;

      const value = sheet.display(row, col);
      // Writing textContent unconditionally would dirty every cell on every
      // frame; most of them have not changed.
      if (td.textContent !== value) td.textContent = value;

      const selected = row === this.selRow && col === this.selCol;
      const cls = className(sheet.columns[col]!.kind, selected);
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
    const sheet = this.sheet;
    if (sheet === undefined) return;

    this.cancelEdit();
    this.selRow = Math.max(0, Math.min(sheet.rows() - 1, row));
    this.selCol = Math.max(0, Math.min(sheet.cols() - 1, col));
    this.scrollIntoView();
    this.layout();
    this.events.onSelect(this.selRow, this.selCol);
  }

  private scrollIntoView(): void {
    const headH = this.head.offsetHeight;
    const top = this.selRow * this.rowHeight;
    const view = this.scroller.scrollTop;
    const height = this.scroller.clientHeight - headH;

    if (top < view) this.scroller.scrollTop = top;
    else if (top + this.rowHeight > view + height) {
      this.scroller.scrollTop = top + this.rowHeight - height;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.sheet === undefined) return;
    if (this.editor !== undefined) return; // the editor has its own keys

    switch (e.key) {
      case "ArrowDown":
        this.select(this.selRow + 1, this.selCol);
        break;
      case "ArrowUp":
        this.select(this.selRow - 1, this.selCol);
        break;
      case "ArrowRight":
      case "Tab":
        this.select(this.selRow, this.selCol + 1);
        break;
      case "ArrowLeft":
        this.select(this.selRow, this.selCol - 1);
        break;
      case "PageDown":
        this.select(this.selRow + this.page(), this.selCol);
        break;
      case "PageUp":
        this.select(this.selRow - this.page(), this.selCol);
        break;
      case "Home":
        this.select(0, 0);
        break;
      case "End":
        this.select(this.sheet.rows() - 1, this.sheet.cols() - 1);
        break;
      case "Enter":
      case "F2":
        this.beginEdit();
        break;
      default:
        // Typing over a cell replaces it, which is what every spreadsheet does.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) this.beginEdit(e.key);
        else return;
    }
    e.preventDefault();
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
  private beginEdit(initial?: string): void {
    const sheet = this.sheet;
    if (sheet === undefined || this.editor !== undefined) return;
    if (sheet.rows() === 0) return;

    // A derived column stores nothing to type over. The sheet would refuse it;
    // saying so before the keystroke is kinder than after it.
    if (sheet.binding(this.selCol) !== undefined) return;

    const input = document.createElement("input");
    input.className = "cell-editor";
    input.value = initial ?? sheet.raw(this.selRow, this.selCol);

    input.addEventListener("keydown", (e) => {
      // Swallowed first, before anything that could fail. Stopping propagation
      // at the end of the handler meant that any throw on the way -- or any
      // early return added later -- let the same Enter reach the grid, which
      // read it as "start editing" and opened a second editor over the cell
      // that had just been committed.
      e.stopPropagation();

      if (e.key === "Enter") {
        e.preventDefault();
        this.commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancelEdit();
        this.focus();
      }
    });
    input.addEventListener("blur", () => this.commitEdit());

    this.editor = input;
    this.sizer.append(input);
    this.placeEditor();
    input.focus();
    if (initial === undefined) input.select();
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
    input.style.top = `${td.offsetTop + this.first * this.rowHeight}px`;
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
    const sheet = this.sheet;
    if (input === undefined || sheet === undefined) return;

    const value = input.value;
    this.cancelEdit();

    if (value !== sheet.raw(this.selRow, this.selCol)) {
      this.events.onEdit(this.selRow, this.selCol, value);
    }
    this.focus();
    this.layout();
  }

  private cancelEdit(): void {
    this.editor?.remove();
    this.editor = undefined;
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
