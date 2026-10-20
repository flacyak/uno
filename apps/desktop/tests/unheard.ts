/**
 * @fileoverview A workspace's events with no one to hear them, for a test
 * that opens a workspace no shell draws.
 */

import type { WorkspaceEvents } from "@renderer/workspace";

/** UNHEARD is every workspace event, each ignored. */
export const UNHEARD: WorkspaceEvents = {
  changed: () => {},
  offered: () => {},
  widened: () => {},
};
