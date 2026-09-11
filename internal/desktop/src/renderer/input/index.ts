// The input strategies, by the name settings, the Edit menu and the saved
// setting use.

import { defaultInput } from "./default.ts";
import type { InputStrategy } from "./strategy.ts";
import type { InputName } from "./strategy.ts";
import { vimStyle } from "./vim-style.ts";

export type { EditorKey, InputName, InputStrategy } from "./strategy.ts";

/** Every strategy, in the order it is offered, with what it is called there. */
export const INPUTS: readonly { name: InputName; label: string }[] = [
  { name: "default", label: "Default" },
  { name: "vim-style", label: "Vim-style" },
];

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
