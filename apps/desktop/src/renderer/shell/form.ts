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
const EDGE = 8;

/** What a frame asks of the form it holds. */
export interface Held {
  /** Sends what the form holds, from Enter or the primary button. */
  submit(): void;
  /** Says whether Enter on `target` sends it. */
  enters(target: EventTarget | null): boolean;
  /** Called when the form closes. */
  closed(): void;
}

export class PopForm {
  private readonly box: HTMLFormElement;
  readonly submit: HTMLButtonElement;
  private readonly note = el("div", "note");
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
    this.box.append(el("div", "title", title));
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
    this.box.append(...fields, this.note, buttons);
    document.body.append(this.box);
    hang(this.box, place, EDGE);
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
  }

  /** Every focusable control, in document order. */
  private controls(): HTMLElement[] {
    return [...this.box.querySelectorAll<HTMLElement>("select, input, button")];
  }
}

/** field is one row of a form: a label and a control. */
export function field(name: string, control: HTMLElement): HTMLElement {
  const line = el("label", "field");
  line.append(el("span", "what", name), control);
  return line;
}
