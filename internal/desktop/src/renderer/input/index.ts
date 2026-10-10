// Registry of input strategies, keyed by the name the Edit menu and the
// saved setting use.

import { m } from "../../paraglide/messages.js";
import { defaultInput } from "./default.ts";
import type { InputStrategy } from "./strategy.ts";
import type { InputName } from "./strategy.ts";
import { vimStyle } from "./vim-style.ts";

export type { EditorKey, InputName, InputStrategy } from "./strategy.ts";

/** All strategy names, in menu order. */
export const INPUTS: readonly InputName[] = ["default", "vim-style"];

/** Returns the localized label for a strategy name. */
export function inputLabel(name: InputName): string {
  return INPUT_LABELS[name]();
}

const INPUT_LABELS: Record<InputName, () => string> = {
  default: m.input_default,
  "vim-style": m.input_vim_style,
};

/** Returns the strategy for a name. Unknown or missing names give the
 * default. */
export function strategy(name: string | null | undefined): InputStrategy {
  switch (name) {
    case "vim-style":
      return vimStyle;
    default:
      return defaultInput;
  }
}
