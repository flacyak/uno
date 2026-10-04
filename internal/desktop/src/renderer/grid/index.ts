// The grid: selection, key handling, marks and the cell editor, on top of the
// virtualised View in view.ts.
//
// It draws any `Rows` implementation. Rows still on their way from an engine
// are drawn as pending.

import "./grid.css";

import { m } from "../../paraglide/messages.js";
import type { InputStrategy } from "../input/strategy.ts";
import { NOTHING, changeOf, isJump, replay, showing, target } from "../keys.ts";
import { dispatch, el } from "../shell/util.ts";
import type { Handlers } from "../shell/util.ts";
import type { Action, Caret, Change, Motion, Pending } from "../keys.ts";
import { num } from "../locale.ts";
import { columnLabel } from "./rows.ts";
import type { Cell, GridEvents, Rows, ShellAction } from "./rows.ts";

/** Actions the grid carries out itself. */
type GridAction = Exclude<Action, ShellAction>;
import { View } from "./view.ts";

export type { GridEvents, Rows, ShellAction } from "./rows.ts";

/** Marks for one Rows source. */
interface Marks {
  /** Cells set with m{a-z}, by letter. */
  readonly named: Map<string, Cell>;
  /** Where the last jump started, for ''. */
  before: Cell | undefined;
}

export class Grid {
  private readonly view: View;
  private editable = false;

  private selRow = 0;
  private selCol = 0;
  private editor: HTMLInputElement | undefined;
  private pending: Pending = NOTHING;

  /** Marks of the current source. Marks are per source and live for the
   * session. */
  private marks: Marks = noMarks();
  /** Marks of every source shown so far, restored when a tab comes back. */
  private readonly marked = new WeakMap<Rows, Marks>();
  /** Value copied by yank, for put. Kept across opens. */
  private register: string | undefined;
  /** Caret mode the open editor was started with. Used to record the change
   * for repeat. */
  private caret: Caret = "all";
  /** Last change, for repeat. */
  private last: Change | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: GridEvents,
    /** Maps key presses to actions. */
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
   * Shows `source`, or clears the grid. `keep` preserves the selection,
   * scroll position and marks, for the same data arriving as a new Rows
   * object (a band replaced by a sheet when entering transform).
   */
  show(source: Rows | undefined, editable: boolean, keep = false): void {
    this.cancelEdit();
    this.editable = editable;
    this.wait(NOTHING);
    if (keep) {
      // Carry the current marks over to the new Rows object.
      if (source !== undefined) this.marked.set(source, this.marks);
    } else {
      this.marks = this.marksOf(source);
      this.selRow = 0;
      this.selCol = 0;
    }
    this.view.show(source, keep);
  }

  /** Shows `why` as an error when it is non-empty. Returns whether it was. */
  private refused(why: string): boolean {
    if (why !== "") this.events.onSay(why, true);
    return why !== "";
  }

  /** Returns the marks stored for `source`, creating them on first use. */
  private marksOf(source: Rows | undefined): Marks {
    if (source === undefined) return noMarks();
    let marks = this.marked.get(source);
    if (marks === undefined) {
      marks = noMarks();
      this.marked.set(source, marks);
    }
    return marks;
  }

  /** Redraws the header and the visible rows. */
  refresh(): void {
    this.view.refresh();
  }

  /** Redraws the visible rows on the next frame. */
  repaint(): void {
    this.view.schedule();
  }

  selection(): { row: number; col: number } {
    return { row: this.selRow, col: this.selCol };
  }

  /** Selects a cell and scrolls it into view. */
  moveTo(row: number, col: number): void {
    this.select(row, col);
  }

  /** Returns whether the cell editor is open. */
  editing(): boolean {
    return this.editor !== undefined;
  }

  focus(): void {
    this.host.focus();
  }

  /** Replaces the input strategy and clears any pending keys. */
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
    this.view.scrollIntoView(this.selRow, this.selCol);
    this.view.layout();
    this.events.onSelect(this.selRow, this.selCol);
  }

  /**
   * Passes a key press to the input strategy and carries out the result.
   * Handled keys are prevented, so a letter that opens the editor reaches it
   * as `text` alone.
   */
  private onKey(e: KeyboardEvent): void {
    if (this.source === undefined) return;
    if (this.editor !== undefined) return; // the editor handles its own keys

    const step = this.input.interpret(this.editable ? "transform" : "view", this.pending, {
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
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

  /** Carries out an action. Grid actions run here; shell actions are passed
   * to `events.onAction`. */
  act(action: Action): void {
    if (Object.hasOwn(this.doing, action.t)) dispatch(this.doing, action as GridAction);
    else this.events.onAction(action as ShellAction);
  }

  /** Handlers for grid actions, by kind. */
  private readonly doing: Handlers<GridAction> = {
    none: () => undefined,
    move: (a) => this.move(a.motion, a.count),
    scroll: (a) => this.view.scrollRow(this.selRow, a.where),
    mark: (a) => this.marks.named.set(a.name, { row: this.selRow, col: this.selCol }),
    "to-mark": (a) => {
      const mark = this.marks.named.get(a.name);
      if (mark === undefined) this.events.onSay(m.mark_not_set({ name: a.name }), true);
      else this.jump(mark.row, mark.col);
    },
    back: () => {
      const before = this.marks.before;
      if (before !== undefined) this.jump(before.row, before.col);
    },
    clear: () => this.write({ t: "set", value: "" }),
    yank: () => this.yank(),
    put: () => {
      if (this.register === undefined) this.events.onSay(m.nothing_yanked(), true);
      else this.write({ t: "set", value: this.register });
    },
    repeat: () => {
      if (this.last !== undefined) this.write(this.last);
    },
    mode: (a) => this.events.onMode(a.to),
    insert: (a) => {
      // The mode switch happens even if the editor then refuses the cell.
      if (a.transform) this.events.onMode("transform");
      this.beginEdit(a.caret, a.text);
    },
    say: (a) => this.events.onSay(a.text, false),
  };

  /** Moves the selection by a motion. */
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

  /** Selects a cell and records where the selection came from, for ''. */
  private jump(row: number, col: number): void {
    const from = { row: this.selRow, col: this.selCol };
    this.select(row, col);
    if (this.selRow !== from.row || this.selCol !== from.col) this.marks.before = from;
  }

  // ---------------------------------------------------------------- editing

  /**
   * Opens the cell editor over the selected cell. The editor starts from the
   * cell's raw value, or from `text` when a typed character opened it.
   */
  private beginEdit(caret: Caret, text?: string): void {
    const source = this.source;
    if (source === undefined || this.editor !== undefined) return;

    // View mode answers with the locked message.
    if (!this.editable) {
      this.events.onSay(this.input.locked, false);
      return;
    }
    if (this.refused(this.refusal(source))) return;

    const input = el("input", "cell-editor");
    input.value = text ?? (caret === "empty" ? "" : source.raw(this.selRow, this.selCol));
    this.caret = caret;

    input.addEventListener("keydown", (e) => {
      // Stop propagation first. If the event reached the grid's own handler,
      // Enter would open a second editor on the cell just committed.
      e.stopPropagation();

      const key = this.input.editorKey(e.key, e.isComposing);
      if (key === undefined) {
        // Tab commits and then moves as it does on the grid. Left to the
        // field it would move focus off the grid.
        if (e.key === "Tab" && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          this.commitEdit();
          this.onKey(e);
        }
        return;
      }
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

  /** Returns why a write to the selected cell is refused, or "" when it is
   * allowed. */
  private refusal(source: Rows): string {
    if (source.rows() === 0) return m.no_rows();
    // A formula column's values come from its binding, so a write is refused.
    if (source.binding(this.selCol) !== undefined) {
      const column = source.columns[this.selCol];
      return m.computed_nothing_to_type({
        column: column === undefined ? m.this_column() : columnLabel(column.header, this.selCol),
      });
    }
    return this.unreadable(source);
  }

  /** Returns why the selected cell is still loading, or "" once it has a
   * value. */
  private unreadable(source: Rows): string {
    if (source.rows() === 0) return m.no_rows();
    if (source.ready?.(this.selRow) === false) {
      return m.row_still_loading({ row: num(this.selRow + 1) });
    }
    return "";
  }

  /**
   * Applies a change to the selected cell directly. Refused where the editor
   * would be. The change is kept for repeat. An unchanged value leaves the
   * cell as it is.
   */
  private write(change: Change): void {
    const source = this.source;
    if (source === undefined) return;
    if (this.refused(this.refusal(source))) return;

    this.last = change;
    const raw = source.raw(this.selRow, this.selCol);
    const value = replay(change, raw);
    if (value === raw) return;
    this.events.onEdit(this.selRow, this.selCol, value);
    this.view.layout();
  }

  /** Copies the selected cell's raw value to the register and the system
   * clipboard. */
  private yank(): void {
    const source = this.source;
    if (source === undefined) return;
    if (this.refused(this.unreadable(source))) return;

    const value = source.raw(this.selRow, this.selCol);
    this.register = value;
    // The clipboard write can be refused by the browser.
    void navigator.clipboard.writeText(value).catch(() => {
      this.events.onSay(m.yank_clipboard_refused(), true);
    });
  }

  private placeEditor(): void {
    const input = this.editor;
    if (input === undefined) return;

    // Close the editor when its cell scrolls out of view.
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
    // Cleared before removal, so the blur fired by removing the input finds
    // the editor already gone.
    this.editor = undefined;
    input.remove();
    this.events.onEditor(false);
  }
}

function noMarks(): Marks {
  return { named: new Map(), before: undefined };
}
