// The input strategies, by the name settings, the Edit menu and the saved
// setting use.

import { m } from "../../paraglide/messages.js";
import { defaultInput } from "./default.ts";
import type { InputStrategy } from "./strategy.ts";
import type { InputName } from "./strategy.ts";
import { vimStyle } from "./vim-style.ts";

export type { EditorKey, InputName, InputStrategy } from "./strategy.ts";

/** Every strategy, in the order it is offered. */
export const INPUTS: readonly InputName[] = ["default", "vim-style"];

/** inputLabel is what a strategy is called where it is offered. */
export function inputLabel(name: InputName): string {
  return INPUT_LABELS[name]();
}

const INPUT_LABELS: Record<InputName, () => string> = {
  default: m.input_default,
  "vim-style": m.input_vim_style,
};

/**
 * strategy is the one a name picks. Anything else -- nothing saved yet, or a
 * name a later build saved -- is the default.
 */
export function strategy(name: string | null | undefined): InputStrategy {
  switch (name) {
    case "vim-style":
      return vimStyle;
    default:
      return defaultInput;
  }
}
