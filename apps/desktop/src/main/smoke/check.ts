/**
 * @fileoverview The shape of a smoke check. See index.ts.
 */

import type { BrowserWindow } from "electron";

import type { Page } from "./page.ts";

export type Input = Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0];

export interface Check {
  name: string;
  /**
   * A request to smoke.js, sent before the check runs and waited on until it
   * is done: `rewrite <key>` rewrites the stand-in's object at <key> with one
   * digit changed, `put <key> ...` puts the objects it holds for those keys
   * into the bucket, and `again [<path>]` starts a second uno on the path and
   * waits for it to exit.
   */
  ask?: string;
  /**
   * A menu item's message and its arguments, sent to the renderer before the
   * check runs, the way the menu sends it.
   */
  send?: readonly [channel: string, ...args: unknown[]];
  /**
   * The keys an application menu item shows. The item is picked before the
   * check runs, the way a person picks it, and has to leave its keys to the page.
   */
  pick?: string;
  /**
   * Input events sent to the window before the check runs, by the path a
   * person's input takes. The window is driven, so it takes them only when
   * `through` is set.
   */
  input?: { events: readonly Input[]; through: boolean };
  /**
   * A selector. Before the check runs, the pointer moves to the middle of what
   * it picks, by the path a person's pointer takes, wherever the window's size
   * has put that.
   */
  hover?: string;
  /**
   * A click, by the path a person's pointer takes, before the check runs: on
   * the middle of what `selector` picks, `count` presses in a row, so two make
   * a double-click.
   */
  click?: { selector: string; count?: number };
  /**
   * A drag, by the path a person's pointer takes, before the check runs: from
   * the middle of what `selector` picks, `by` CSS px on, where it lets go. With
   * `held` the button stays down, for a later check to let go of.
   */
  drag?: { selector: string; by: { x: number; y: number }; held?: boolean };
  /** The same drag with a finger. No run has a touch screen, so DevTools sends it. */
  touch?: { selector: string; by: { x: number; y: number } };
  /**
   * A turn of the wheel, by the path a person's wheel takes, before the check
   * runs: over the middle of what `selector` picks, `down` CSS px down the page,
   * with `modifiers` held.
   */
  wheel?: { selector: string; down: number; modifiers?: Array<"shift" | "control"> };
  /**
   * The window's zoom and width, set before the check runs, the way the View
   * menu and a drag of its edge set them. What is left out goes back to what
   * the run started with.
   */
  window?: { zoom?: number; width?: number };
  /** A check over `Page`. Returns a message on failure, or "" on success. */
  run?: (page: Page) => Promise<string>;
  /**
   * A check that runs in the renderer, as an async function body wrapped in
   * index.ts's PRELUDE. Returns the same as `run`. Exactly one of `run` or
   * `script` is set.
   */
  script?: string;
  /**
   * The name of a screenshot to take once the check passes. Written as
   * <name>.png beside window.png.
   */
  shot?: string;
}
