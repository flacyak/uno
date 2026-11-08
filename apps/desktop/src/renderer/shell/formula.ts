/**
 * @fileoverview The formula form: picks a column of the active source and the
 * expression it is computed from. It opens from the right-click menu on a
 * workspace.
 *
 * The engine parses the expression. A refusal is shown in the form, which
 * stays open.
 */

import { m } from "@paraglide/messages";
import { clamp } from "@renderer/grid/metrics";
import { columnLabel } from "@renderer/grid/rows";
import { PopForm, field } from "./form.ts";
import type { MenuPlace } from "./menu.ts";
import { el, message, option } from "./util.ts";

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

export class FormulaForm {
  private readonly form: PopForm;
  private readonly column = el("select");
  private readonly expr = el("input");

  constructor(
    place: MenuPlace,
    /** The name of the source the formula goes into. */
    source: string,
    private readonly columns: readonly FormulaColumn[],
    /** The column selected in the grid, which is offered first. */
    selected: number,
    private readonly asks: FormulaAsks,
  ) {
    const title = m.formula_title_source({ source });
    this.form = new PopForm("formula", m.formula_title(), title, m.action_insert(), {
      submit: () => void this.insert(),
      // Enter in the expression field submits.
      enters: (target) => target === this.expr,
      closed: () => asks.closed(),
    });

    for (const [i, c] of columns.entries()) {
      // A blank header is labelled by its position, as in the grid.
      this.column.append(option(columnLabel(c.header, i), String(i)));
    }
    this.column.value = String(clamp(selected, columns.length - 1));
    this.column.setAttribute("aria-label", m.formula_column());
    // Changing the column fills in its current expression, if any.
    this.column.addEventListener("change", () => this.fill());

    this.expr.type = "text";
    this.expr.spellcheck = false;
    this.expr.autocomplete = "off";
    this.expr.setAttribute("aria-label", m.formula_expression_aria());
    this.expr.addEventListener("input", () => this.form.say(m.formula_hint(), false));

    this.form.open([field(m.formula_column(), this.column), field("=", this.expr)], place);
    this.fill();
    this.expr.focus();
  }

  close(): void {
    this.form.close();
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
    this.form.say(m.formula_hint(), false);
  }

  /** insert submits the formula and closes once the engine accepts it. */
  private async insert(): Promise<void> {
    const expr = this.expr.value.trim();
    if (expr === "") {
      this.form.say(m.formula_needs_expression(), true);
      this.expr.focus();
      return;
    }
    this.form.submit.disabled = true;
    try {
      await this.asks.insert(Number(this.column.value), expr);
      this.close();
    } catch (err) {
      this.form.say(message(err), true);
      this.expr.focus();
    } finally {
      this.form.submit.disabled = false;
    }
  }
}
