// An input strategy maps key presses to grid actions. The grid and its cell
// editor ask the strategy what a key means and carry out the answer.
// Strategies are pure functions of mode, pending keys and the press.

import type { Mode, Pending, Press, Step } from "../keys.ts";

/** Strategy name used by the menu and the saved setting. */
export type InputName = "default" | "vim-style";

/** What a key does in the cell editor. Undefined leaves it to the input
 * field. */
export type EditorKey = "commit" | "cancel" | undefined;

export interface InputStrategy {
  readonly name: InputName;
  /** Message shown when a writing key is pressed in view mode. */
  readonly locked: string;
  /** Status bar label while the editor is open, or undefined to keep the
   * transform label. */
  readonly editing: string | undefined;
  /** Tooltip for the mode switch. */
  readonly switchHint: string;

  /**
   * Interprets one key press on the grid.
   *
   * Returns undefined when the key belongs elsewhere (a shell or menu chord,
   * a bare modifier). The grid then leaves the event alone and keeps its
   * pending keys. Any other result is treated as handled and the event is
   * prevented.
   */
  interpret(mode: Mode, pending: Pending, press: Press): Step | undefined;

  /**
   * Interprets one key press in the cell editor. Returns undefined while an
   * input method is composing, since Enter and Esc then belong to the
   * composition.
   */
  editorKey(key: string, composing: boolean): EditorKey;
}
