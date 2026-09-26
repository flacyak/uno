// The shape of a smoke check. See index.ts.

import type { BrowserWindow } from "electron";

import type { Page } from "./page.ts";

export type Input = Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0];

export interface Check {
  name: string;
  /**
   * A menu item's message and what it carries, sent before the check runs the
   * way the menu sends it. An accelerator is the main process's, so a key the
   * page dispatches never reaches one.
   */
  send?: readonly [channel: string, ...args: unknown[]];
  /**
   * Input sent before the check runs, down the path the window system sends a
   * person's. The window is driven, so it drops all of it unless `through` is set.
   */
  input?: { events: readonly Input[]; through: boolean };
  /**
   * A check over `Page`, for the ones that only ever need what `Page` can say.
   * Returns a message on failure, or "" when it passes.
   */
  run?: (page: Page) => Promise<string>;
  /**
   * A check that still needs the renderer itself: real layout, the real
   * preload bridge, or a person's own input. Runs in the renderer, wrapped in
   * index.ts's PRELUDE. Exactly one of `run` or `script` is set.
   */
  script?: string;
}
