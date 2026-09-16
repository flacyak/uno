// The shape of a smoke check. See index.ts.

import type { BrowserWindow } from "electron";

import type { Page } from "./page.ts";

export type Input = Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0];

export interface Check {
  name: string;
  /**
   * A request to smoke.js, sent before the check runs and waited on until it
   * is done: `rewrite <key>` rewrites the stand-in's object at <key> with one
   * digit changed, and `put <key> ...` puts the objects it holds for those
   * keys into the bucket.
   */
  ask?: string;
  /**
   * A menu item's message and its arguments, sent to the renderer before the
   * check runs, the way the menu sends it.
   */
  send?: readonly [channel: string, ...args: unknown[]];
  /**
   * Input events sent to the window before the check runs, by the path a
   * person's input takes. The window is driven, so it takes them only when
   * `through` is set.
   */
  input?: { events: readonly Input[]; through: boolean };
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
