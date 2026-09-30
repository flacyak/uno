// The formula form: picks a column of the active source and the expression it
// is computed from. It opens from the right-click menu on a workspace.
//
// The engine parses the expression. A refusal is shown in the form, which
// stays open.

import "./formula.css";

import { m } from "../../paraglide/messages.js";
import { columnLabel } from "../grid/rows.ts";
import type { MenuPlace } from "./menu.ts";
import { clickAway, el, hang, message, option, walk } from "./util.ts";

/**
 * A column the form offers, with the expression it is already computed from, if
 * any.
 */
export interface FormulaColumn {
  header: string;
  binding?: string;
}

/** What the form asks of the shell. */
export interface FormulaAsks {
  /** Compute column `col` from `expr`. Throws with a message when refused. */
  insert(col: number, expr: string): Promise<void>;
  /** Called when the form closes. */
  closed(): void;
}

/** A header an expression can refer to: a letter or underscore, then
 * letters, digits and underscores. */
const NAMEABLE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** The minimum gap between the form and the window's edge, in pixels. */
const EDGE = 8;

export class FormulaForm {
  private readonly box = el("form", "formula");
  private readonly column = el("select");
  private readonly expr = el("input");
  private readonly note = el("div");
  private readonly submit = el("button", "primary", m.action_insert());
  private disarm: () => void = () => {};

  constructor(
    place: MenuPlace,
    /** The name of the source the formula goes into. */
    source: string,
    private readonly columns: readonly FormulaColumn[],
    /** The column selected in the grid, which is offered first. */
    selected: number,
    private readonly asks: FormulaAsks,
  ) {
    this.box.setAttribute("aria-label", m.formula_title());
    this.box.noValidate = true;

    const title = el("div", "title", m.formula_title_source({ source }));

    for (const [i, c] of columns.entries()) {
      // A blank header is labelled by its position, as in the grid.
      this.column.append(option(columnLabel(c.header, i), String(i)));
    }
    this.column.value = String(Math.min(Math.max(selected, 0), columns.length - 1));
    this.column.setAttribute("aria-label", m.formula_column());
    // Changing the column fills in its current expression, if any.
    this.column.addEventListener("change", () => this.fill());

    this.expr.type = "text";
    this.expr.spellcheck = false;
    this.expr.autocomplete = "off";
    this.expr.setAttribute("aria-label", m.formula_expression_aria());
    this.expr.addEventListener("input", () => this.say(m.formula_hint(), false));

    const cancel = el("button", "", m.action_cancel());
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    this.submit.type = "submit";

    const buttons = el("div", "buttons");
    buttons.append(cancel, this.submit);
    this.box.append(
      title,
      field(m.formula_column(), this.column),
      field("=", this.expr),
      this.note,
      buttons,
    );

    this.box.addEventListener("keydown", (e) => {
      // Keep the key from reaching the grid and the shell's shortcuts.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
        return;
      }
      // Tab stays inside the form.
      if (walk(e, this.controls())) return;
      if (e.key === "Enter" && e.target === this.expr) {
        // Enter in the expression field submits.
        e.preventDefault();
        void this.insert();
      }
    });
    this.box.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.insert();
    });

    document.body.append(this.box);
    hang(this.box, place, EDGE);
    this.fill();
    this.expr.focus();
    this.disarm = clickAway(this.box, () => this.close());
  }

  close(): void {
    if (!this.box.isConnected) return;
    this.disarm();
    this.box.remove();
    this.asks.closed();
  }

  /** Every focusable control, in document order. */
  private controls(): HTMLElement[] {
    return [...this.box.querySelectorAll<HTMLElement>("select, input, button")];
  }

  /** fill writes the chosen column's expression into the field, or clears it,
   * and sets a placeholder naming two other columns as an example. */
  private fill(): void {
    const col = Number(this.column.value);
    const others = this.columns
      .filter((c, i) => i !== col && NAMEABLE.test(c.header))
      .map((c) => c.header);
    this.expr.placeholder = others.length >= 2 ? `${others.at(-1)} / ${others.at(-2)}` : "";
    this.expr.value = this.columns[col]?.binding ?? "";
    this.expr.select();
    this.say(m.formula_hint(), false);
  }

  /** insert submits the formula and closes once the engine accepts it. */
  private async insert(): Promise<void> {
    const expr = this.expr.value.trim();
    if (expr === "") {
      this.say(m.formula_needs_expression(), true);
      this.expr.focus();
      return;
    }
    this.submit.disabled = true;
    try {
      await this.asks.insert(Number(this.column.value), expr);
      this.close();
    } catch (err) {
      this.say(message(err), true);
      this.expr.focus();
    } finally {
      this.submit.disabled = false;
    }
  }

  private say(text: string, isError: boolean): void {
    this.note.textContent = text;
    this.note.title = text;
    this.note.className = isError ? "note err" : "note";
  }
}

/** field is one row of the form: a label and a control. */
function field(name: string, control: HTMLElement): HTMLElement {
  const line = el("label", "field");
  line.append(el("span", "what", name), control);
  return line;
}
