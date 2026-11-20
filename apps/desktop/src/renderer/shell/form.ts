/**
 * @fileoverview What the pop-up forms share: their look, the frame round a
 * form's fields, and a field of one label and one control. Every key stays in a
 * frame, Escape closes it, Tab walks its controls round the ends, and a press
 * outside it closes it.
 */

import "./form.css";

import { m } from "@paraglide/messages";
import type { MenuPlace } from "./menu.ts";
import { button, clickAway, el, hang, walk } from "./util.ts";

/** The minimum gap between a form and the window's edge, in pixels. */
export const EDGE = 8;

/** Every pop-up form's worded labels. Each form's label column is as wide as
 * the longest of them in the language spoken, so the forms' controls line up. */
export const LABELS: ReadonlyArray<() => string> = [
  m.formula_column,
  m.chart_form_source,
  m.chart_form_kind,
  m.chart_kinds_compare,
  m.chart_kinds_trend,
  m.chart_kinds_relate,
  m.chart_form_at,
  m.chart_form_order,
  m.chart_form_per,
  m.chart_form_by,
  m.chart_form_sum,
  m.chart_form_split,
  m.chart_form_x,
  m.chart_form_y,
  m.chart_form_title_field,
  m.chart_form_refresh,
];

/** Splits a label into the letters a reader sees. */
const LETTERS = new Intl.Segmenter();

/** What a frame asks of the form it holds. */
export interface Held {
  /** Sends what the form holds, from Enter or the primary button. */
  submit(): void;
  /** Says whether Enter on `target` sends it. */
  enters(target: EventTarget | null): boolean;
  /** Called when the form closes. */
  closed(): void;
}

/** What a form wears while the page holds it only in part, its fields scrolling. */
const CAPPED = "capped";

export class PopForm {
  private readonly box: HTMLFormElement;
  /** The title line. */
  readonly heading = el("div", "title");
  readonly submit: HTMLButtonElement;
  private readonly note = el("div", "note");
  /** The fields, which scroll where the page holds the form only in part. */
  private readonly fields = el("div", "fields themed-bar");
  private disarm: () => void = () => {};

  constructor(
    /** The form's own class, beside pop-form. */
    cls: string,
    /** What a screen reader calls the form. */
    label: string,
    /** The title line. */
    title: string,
    /** The primary button's words. */
    primary: string,
    private readonly held: Held,
  ) {
    this.box = el("form", `pop-form ${cls}`);
    this.box.setAttribute("aria-label", label);
    this.box.noValidate = true;
    this.heading.textContent = title;
    this.box.append(this.heading);
    this.submit = el("button", "primary", primary);
    this.submit.type = "submit";

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
      if (e.key === "Enter" && held.enters(e.target)) {
        e.preventDefault();
        held.submit();
      }
    });
    this.box.addEventListener("submit", (e) => {
      e.preventDefault();
      held.submit();
    });
  }

  /** open puts `fields` under the title line and hangs the form at `place`. */
  open(fields: readonly HTMLElement[], place: MenuPlace): void {
    const cancel = button("", m.action_cancel(), () => this.close());
    const buttons = el("div", "buttons");
    buttons.append(cancel, this.submit);
    this.fields.append(...fields);
    this.box.append(this.fields, this.note, buttons);
    // The forms are set in a monospaced font, so a label of n letters is n ch wide.
    const longest = Math.max(...LABELS.map((label) => [...LETTERS.segment(label())].length));
    this.box.style.setProperty("--label-width", `${longest}ch`);
    document.body.append(this.box);
    this.hangAt(place);
    this.disarm = clickAway(this.box, () => this.close());
  }

  close(): void {
    if (!this.box.isConnected) return;
    this.disarm();
    this.box.remove();
    this.held.closed();
  }

  say(text: string, isError: boolean): void {
    this.note.textContent = text;
    this.note.title = text;
    this.note.className = isError ? "note err" : "note";
    // A note of more lines makes the form taller, so it is hung again inside the window.
    if (this.box.isConnected) this.hangAt(this.box.getBoundingClientRect());
  }

  /**
   * hangAt hangs the form at `place`. Where the page under `place` is too short
   * for the whole form but holds its title, its first field, its note and its
   * buttons, the form keeps its top there and ends EDGE inside the page, and
   * its fields scroll; where it holds less, the form rises as hang() lifts it.
   */
  private hangAt(place: MenuPlace): void {
    this.box.style.maxHeight = "";
    this.box.classList.remove(CAPPED);
    const room = window.innerHeight - EDGE - place.top;
    const whole = this.box.getBoundingClientRect().height;
    const first = this.fields.querySelector(".field:not([hidden])");
    const least = whole - this.fields.scrollHeight + (first?.getBoundingClientRect().height ?? 0);
    if (whole > room && room >= least) {
      this.box.style.maxHeight = `${room}px`;
      this.box.classList.add(CAPPED);
    }
    hang(this.box, place, EDGE);
  }

  /** Every focusable control outside a hidden field, in document order, a radio group by its choice. */
  private controls(): HTMLElement[] {
    const all = [...this.box.querySelectorAll<HTMLElement>("select, input, button")];
    const unchosen = (c: HTMLElement) =>
      c instanceof HTMLInputElement && c.type === "radio" && !c.checked;
    return all.filter((c) => c.closest("[hidden]") === null && !unchosen(c));
  }
}

/** field is one row of a form: a label and a control. A worded `name` is one
 * of LABELS, so the label column is wide enough for it. */
export function field(name: string, control: HTMLElement): HTMLElement {
  const line = el("label", "field");
  line.append(el("span", "what", name), control);
  return line;
}
