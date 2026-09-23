// The formula form: which column of the source showing is computed, and from
// what. It opens from a right click on a workspace in the sidebar.
//
// A formula is arithmetic over the row's other columns, by their names. The
// column it is put on stops storing values of its own and shows what the
// expression computes, and it is one edit in the log, so Ctrl+Z takes it back.
//
// The form says nothing about what an expression may be. The engine parses it
// and answers in its own words, here, with the form still open on what was
// typed.

import "./formula.css";

import type { MenuPlace } from "./menu.ts";
import { message } from "./util.ts";

/** A column the form offers, with the expression it is computed from already. */
export interface FormulaColumn {
  header: string;
  binding?: string;
}

/** What the form asks of the shell. The shell decides; the form only asks. */
export interface FormulaAsks {
  /** Compute column `col` from `expr`. A refusal is thrown, saying why. */
  insert(col: number, expr: string): Promise<void>;
  /** The form closed, so the keys go back to the grid. */
  closed(): void;
}

/** What the form says under the expression until the engine has said something else. */
export const FORMULA_HINT = "columns by name · + - * / ( )";

/** A header an expression can name: letters, digits and underscores, not
 * starting with a digit, as the engine reads one. */
const NAMEABLE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** The least room the form keeps between itself and the window's edge, in pixels. */
const EDGE = 8;

export class FormulaForm {
  private readonly box = document.createElement("form");
  private readonly column = document.createElement("select");
  private readonly expr = document.createElement("input");
  private readonly note = document.createElement("div");
  private readonly submit = document.createElement("button");
  private readonly away = (e: MouseEvent): void => {
    if (!this.box.contains(e.target as Node)) this.close();
  };

  constructor(
    place: MenuPlace,
    /** The source the formula goes into, by the name on its tab. */
    source: string,
    private readonly columns: readonly FormulaColumn[],
    /** The column the grid has selected, which is the one offered first. */
    selected: number,
    private readonly asks: FormulaAsks,
  ) {
    this.box.className = "formula";
    this.box.setAttribute("aria-label", "Insert formula");
    this.box.noValidate = true;

    const title = element("div", "title", `Insert formula · ${source}`);

    for (const [i, c] of columns.entries()) {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = c.header;
      this.column.append(option);
    }
    this.column.value = String(Math.min(Math.max(selected, 0), columns.length - 1));
    this.column.setAttribute("aria-label", "column");
    // A column that is computed already opens on its expression, to change it.
    this.column.addEventListener("change", () => this.fill());

    this.expr.type = "text";
    this.expr.spellcheck = false;
    this.expr.autocomplete = "off";
    this.expr.setAttribute("aria-label", "expression");
    this.expr.addEventListener("input", () => this.say(FORMULA_HINT, false));

    const cancel = element("button", "", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    this.submit.type = "submit";
    this.submit.className = "primary";
    this.submit.textContent = "Insert";

    const buttons = element("div", "buttons", "");
    buttons.append(cancel, this.submit);
    this.box.append(title, field("column", this.column), field("=", this.expr), this.note, buttons);

    this.box.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter" && e.target === this.expr) {
        // Enter in the expression is Insert, said here rather than left to
        // the form, so it is the same key however the key arrived.
        e.preventDefault();
        void this.insert();
      }
    });
    this.box.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.insert();
    });

    document.body.append(this.box);
    const { width, height } = this.box.getBoundingClientRect();
    const left = Math.min(place.left, window.innerWidth - width - EDGE);
    const top = Math.min(place.top, window.innerHeight - height - EDGE);
    this.box.style.left = `${Math.max(EDGE, left)}px`;
    this.box.style.top = `${Math.max(EDGE, top)}px`;

    this.fill();
    this.expr.focus();
    // After this click has finished, or it would close the form it opened.
    setTimeout(() => document.addEventListener("mousedown", this.away), 0);
  }

  close(): void {
    if (!this.box.isConnected) return;
    document.removeEventListener("mousedown", this.away);
    this.box.remove();
    this.asks.closed();
  }

  /** fill writes the chosen column's expression into the field, or clears it,
   * and names two of the other columns as an example of one. */
  private fill(): void {
    const col = Number(this.column.value);
    const others = this.columns
      .filter((c, i) => i !== col && NAMEABLE.test(c.header))
      .map((c) => c.header);
    this.expr.placeholder = others.length >= 2 ? `${others.at(-1)} / ${others.at(-2)}` : "";
    this.expr.value = this.columns[col]?.binding ?? "";
    this.expr.select();
    this.say(FORMULA_HINT, false);
  }

  /** insert asks for the formula, and closes once the engine has taken it. */
  private async insert(): Promise<void> {
    const expr = this.expr.value.trim();
    if (expr === "") {
      this.say("an expression to compute the column from", true);
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

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls !== "") el.className = cls;
  el.textContent = text;
  return el;
}

/** field is one line of the form: what the control is, and the control. */
function field(name: string, control: HTMLElement): HTMLElement {
  const line = element("label", "field", "");
  line.append(element("span", "what", name), control);
  return line;
}
