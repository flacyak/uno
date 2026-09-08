// An input strategy: how a person's keys become the grid's actions.
//
// The grid and its editor ask the strategy what a key means and carry out the
// answer, so a way of typing is one object rather than a branch through the
// grid. A strategy is pure -- a mode, what is pending and a key in, a step out --
// so each one is tested without a window.

import type { Mode, Pending, Press, Step } from "../keys.ts";

/** The name the menu and the saved setting know a strategy by. */
export type InputName = "vim-style";

/** What a key in the cell editor does. Undefined leaves the key to the field. */
export type EditorKey = "commit" | "cancel" | undefined;

export interface InputStrategy {
  readonly name: InputName;
  /** What a key that writes says in view. */
  readonly locked: string;
  /** What the status bar calls transform while the editor is open, or undefined to go on calling it transform. */
  readonly editing: string | undefined;
  /** The mode switch's tooltip: how to get between view and transform. */
  readonly switchHint: string;

  /**
   * interpret reads one key on the grid, in view or transform.
   *
   * Undefined means the key is not the grid's -- a chord for the shell and the
   * menu, or Shift on its way to a capital -- and leaves what is pending alone.
   * Every other key is prevented, so a letter the grid takes is never typed into
   * an editor it opened.
   */
  interpret(mode: Mode, pending: Pending, press: Press): Step | undefined;

  /**
   * editorKey reads one key in the cell editor. While an input method is
   * composing, Enter and Esc belong to the composition, and closing the editor
   * would cut a word in half.
   */
  editorKey(key: string, composing: boolean): EditorKey;
}
