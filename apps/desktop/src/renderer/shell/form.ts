/**
 * @fileoverview What the pop-up forms share: their look, and a field of one
 * label and one control.
 */

import "./form.css";

import { el } from "./util.ts";

/** field is one row of a form: a label and a control. */
export function field(name: string, control: HTMLElement): HTMLElement {
  const line = el("label", "field");
  line.append(el("span", "what", name), control);
  return line;
}
