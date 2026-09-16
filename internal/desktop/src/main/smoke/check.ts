// The shape of a smoke check. See index.ts.

import type { BrowserWindow } from "electron";

export type Input = Parameters<BrowserWindow["webContents"]["sendInputEvent"]>[0];

export interface Check {
  name: string;
  /**
   * A menu item's message and what it carries, sent before the script runs the
   * way the menu sends it. An accelerator is the main process's, so a key the
   * page dispatches never reaches one.
   */
  send?: readonly [channel: string, ...args: unknown[]];
  /**
   * Input sent before the script runs, down the path the window system sends a
   * person's. The window is driven, so it drops all of it unless `through` is set.
   */
  input?: { events: readonly Input[]; through: boolean };
  /** Runs in the renderer. Returns a message on failure, or "" when it passes. */
  script: string;
}
