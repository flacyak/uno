// The grid: the selection, what the keys do to it, and the cell editor, over a
// view that holds only the rows you can see (view.ts).
//
// It draws a Sheet or a band of rows from an engine through `Rows`, and cannot
// tell which. A row the band has not received yet is drawn pending and filled
// in when it lands. Nothing here waits.

import "./grid.css";

import type { InputStrategy } from "../input/strategy.ts";
import { NOTHING, changeOf, isJump, replay, showing, target } from "../keys.ts";
import type { Action, Caret, Change, Motion, Pending } from "../keys.ts";
import type { Cell, GridEvents, Rows } from "./rows.ts";
import { View } from "./view.ts";

export type { GridEvents, Rows, ShellAction } from "./rows.ts";

export class Grid {
  private readonly view: View;
  private editable = false;

  private selRow = 0;
  private selCol = 0;
  private editor: HTMLInputElement | undefined;
  private pending: Pending = NOTHING;

  /**
   * Marks belong to the open workspace: not saved in the .uno, and cleared by
   * the next open. A row keeps its number, because the log has no row insert or
   * delete, so a mark stays on the same record.
   */
  private marks = new Map<string, Cell>();
  /** Where the last jump left from, for ''. */
  private before: Cell | undefined;
  /** What yy copied, for p. Kept across opens, as vim keeps a register across files. */
  private register: string | undefined;
  /** How the open editor was opened, so . can tell what the insert did. */
  private caret: Caret = "all";
  /** The last insert, x or p, for . to make again. */
  private last: Change | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: GridEvents,
    /** How keys are read. The grid carries out what the strategy says a key means. */
    private input: InputStrategy,
  ) {
    this.view = new View(
      host,
      () => ({ row: this.selRow, col: this.selCol }),
      () => this.placeEditor(),
    );
    this.view.scroller.addEventListener("click", (e) => this.onClick(e));
    this.view.scroller.addEventListener("dblclick", () => this.beginEdit("all"));
    this.host.addEventListener("keydown", (e) => this.onKey(e));
  }

  private get source(): Rows | undefined {
    return this.view.source;
  }

  /**
   * Show rows, or nothing. `keep` holds the selection and the scroll position,
   * for the same rows drawn from somewhere else -- a band handing over to a
   * sheet when a file enters transform.
   */
  show(source: Rows | undefined, editable: boolean, keep = false): void {
    this.cancelEdit();
    this.editable = editable;
    this.wait(NOTHING);
    if (!keep) {
      this.marks = new Map();
      this.before = undefined;
      this.selRow = 0;
      this.selCol = 0;
    }
    this.view.show(source, keep);
  }

  /** Redraw what is on screen. Called when an edit lands, because a bound column
   * anywhere in view may have recomputed. */
  refresh(): void {
    this.view.refresh();
  }

  /** Redraw the body on the next frame: rows arrived, or the row count moved. */
  repaint(): void {
    this.view.schedule();
  }

  selection(): { row: number; col: number } {
    return { row: this.selRow, col: this.selCol };
  }

  /** moveTo selects a cell and brings it into view, as a key would. */
  moveTo(row: number, col: number): void {
    this.select(row, col);
  }

  /** Whether the cell editor is open. */
  editing(): boolean {
    return this.editor !== undefined;
  }

  focus(): void {
    this.host.focus();
  }

  /** setInput changes how keys are read. Keys waiting for more were read the old way, so they go. */
  setInput(input: InputStrategy): void {
    this.input = input;
    this.wait(NOTHING);
  }

  // ------------------------------------------------------------ interaction

  private onClick(e: MouseEvent): void {
    const cell = this.view.cellAt(e.target as HTMLElement);
    if (cell !== undefined) this.select(cell.row, cell.col);
  }

  private select(row: number, col: number): void {
    const source = this.source;
    if (source === undefined) return;

    this.cancelEdit();
    this.selRow = Math.max(0, Math.min(source.rows() - 1, row));
    this.selCol = Math.max(0, Math.min(source.cols() - 1, col));
    this.view.scrollIntoView(this.selRow);
    this.view.layout();
    this.events.onSelect(this.selRow, this.selCol);
  }

  /**
   * onKey hands a key to the input strategy and carries out what it means.
   *
   * Every key the grid takes is prevented, so a letter that opens the editor is
   * not typed into it as well.
   */
  private onKey(e: KeyboardEvent): void {
    if (this.source === undefined) return;
    if (this.editor !== undefined) return; // the editor has its own keys

    const step = this.input.interpret(this.editable ? "transform" : "view", this.pending, {
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      repeat: e.repeat,
    });
    if (step === undefined) return;
    e.preventDefault();
    this.wait(step.pending);
    this.act(step.action);
  }

  private wait(pending: Pending): void {
    const before = showing(this.pending);
    this.pending = pending;
    if (showing(pending) !== before) this.events.onPending(showing(pending));
  }

  /**
   * act carries out an action as if its keys had been pressed. The shell calls
   * it for :{n}, which is {n}G typed at the command line.
   */
  act(action: Action): void {
    switch (action.t) {
      case "none":
        return;
      case "move":
        this.move(action.motion, action.count);
        return;
      case "scroll":
        this.view.scrollRow(this.selRow, action.where);
        return;
      case "mark":
        this.marks.set(action.name, { row: this.selRow, col: this.selCol });
        return;
      case "to-mark": {
        const mark = this.marks.get(action.name);
        if (mark === undefined) this.events.onSay(`mark ${action.name} is not set`, true);
        else this.jump(mark.row, mark.col);
        return;
      }
      case "back":
        if (this.before !== undefined) this.jump(this.before.row, this.before.col);
        return;
      case "clear":
        this.write({ t: "set", value: "" });
        return;
      case "yank":
        this.yank();
        return;
      case "put":
        if (this.register === undefined) this.events.onSay("nothing yanked", true);
        else this.write({ t: "set", value: this.register });
        return;
      case "repeat":
        if (this.last !== undefined) this.write(this.last);
        return;
      case "mode":
        this.events.onMode(action.to);
        return;
      case "insert":
        // a in view: the switch writes nothing and was asked for, so it happens
        // even when the editor then refuses the cell.
        if (action.transform) this.events.onMode("transform");
        this.beginEdit(action.caret, action.text);
        return;
      case "say":
        this.events.onSay(action.text, false);
        return;
      default:
        this.events.onAction(action);
    }
  }

  /** move goes where keys.ts says a motion lands. None of them write. */
  private move(motion: Motion, count: number | undefined): void {
    const source = this.source;
    if (source === undefined) return;

    const rows = source.rows();
    const to = target(motion, count, {
      row: this.selRow,
      col: this.selCol,
      rows,
      cols: source.cols(),
      readable: source.readable?.() ?? rows,
      page: this.view.page(),
      ...this.view.visibleRows(),
    });
    if (isJump(motion)) this.jump(to.row, to.col);
    else this.select(to.row, to.col);
    if (to.short !== undefined) this.events.onShort(to.short);
  }

  /**
   * jump selects a cell and remembers where the selection left from, so '' can
   * go back. Going back is a jump too, which makes '' twice return.
   */
  private jump(row: number, col: number): void {
    const from = { row: this.selRow, col: this.selCol };
    this.select(row, col);
    if (this.selRow !== from.row || this.selCol !== from.col) this.before = from;
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
  private beginEdit(caret: Caret, text?: string): void {
    const source = this.source;
    if (source === undefined || this.editor !== undefined) return;

    // In view a keystroke changes nothing, and says what would.
    if (!this.editable) {
      this.events.onSay(this.input.locked, false);
      return;
    }
    const refused = this.refusal(source);
    if (refused !== "") {
      this.events.onSay(refused, true);
      return;
    }

    const input = document.createElement("input");
    input.className = "cell-editor";
    // Typing over a cell starts the editor holding what was typed.
    input.value = text ?? (caret === "empty" ? "" : source.raw(this.selRow, this.selCol));
    this.caret = caret;

    input.addEventListener("keydown", (e) => {
      // Swallowed first, before anything that could fail. Stopping propagation
      // at the end of the handler meant that any throw on the way -- or any
      // early return added later -- let the same Enter reach the grid, which
      // read it as "start editing" and opened a second editor over the cell
      // that had just been committed.
      e.stopPropagation();

      // Whether Esc keeps the typing is the strategy's to say.
      const key = this.input.editorKey(e.key, e.isComposing);
      if (key === undefined) return;
      e.preventDefault();
      if (key === "commit") {
        this.commitEdit();
      } else {
        this.cancelEdit();
        this.focus();
      }
    });
    input.addEventListener("blur", () => this.commitEdit());

    this.editor = input;
    this.view.hold(input);
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
    return this.unreadable(source);
  }

  /** unreadable says why the selected cell has no value here, or "" when it has one. */
  private unreadable(source: Rows): string {
    if (source.rows() === 0) return "no rows";
    if (source.ready?.(this.selRow) === false) {
      return `row ${(this.selRow + 1).toLocaleString()} is still loading`;
    }
    return "";
  }

  /**
   * write changes the selected cell from a key rather than through the editor,
   * and is refused wherever the editor would be. A value the cell already holds
   * records nothing. What it did is what . does next.
   */
  private write(change: Change): void {
    const source = this.source;
    if (source === undefined) return;
    const refused = this.refusal(source);
    if (refused !== "") {
      this.events.onSay(refused, true);
      return;
    }

    this.last = change;
    const raw = source.raw(this.selRow, this.selCol);
    const value = replay(change, raw);
    if (value === raw) return;
    this.events.onEdit(this.selRow, this.selCol, value);
    this.view.layout();
  }

  /**
   * yank copies what the cell stores to the register and the system clipboard.
   * It copies raw rather than what is shown, because p puts it back into a cell
   * and the editor works on stored values, and the two should agree.
   */
  private yank(): void {
    const source = this.source;
    if (source === undefined) return;
    const unreadable = this.unreadable(source);
    if (unreadable !== "") {
      this.events.onSay(unreadable, true);
      return;
    }

    const value = source.raw(this.selRow, this.selCol);
    this.register = value;
    // The register is uno's copy. The system clipboard is a courtesy a page can
    // be refused, without focus or permission.
    void navigator.clipboard.writeText(value).catch(() => {
      this.events.onSay("yanked, but the system clipboard refused it", true);
    });
  }

  private placeEditor(): void {
    const input = this.editor;
    if (input === undefined) return;

    // The cell being edited scrolled out of view. Keeping the entry where the
    // cell was would leave it floating over a different row.
    if (!this.view.place(input, this.selRow, this.selCol)) this.cancelEdit();
  }

  private commitEdit(): void {
    const input = this.editor;
    const source = this.source;
    if (input === undefined || source === undefined) return;

    const value = input.value;
    this.cancelEdit();

    const raw = source.raw(this.selRow, this.selCol);
    if (value !== raw) {
      this.last = changeOf(this.caret, raw, value);
      this.events.onEdit(this.selRow, this.selCol, value);
    }
    this.focus();
    this.view.layout();
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
