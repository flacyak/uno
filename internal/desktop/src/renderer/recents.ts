// The workspaces opened on this machine, most recent first: what the sidebar
// lists.
//
// A .uno is listed once it has been opened from a path or saved to one. The
// list is this machine's, kept the way the theme and the input strategy are,
// and it holds paths and nothing else: a workspace that moved or was deleted
// is found out when it is opened, and says so then.

import type { Keeps } from "./theme.ts";

/** Where the list is kept. */
export const RECENTS_KEY = "uno.recents";

/** The most the list holds. The one opened longest ago goes first. */
export const RECENTS_MAX = 30;

export class Recents {
  private paths: string[];

  constructor(private readonly kept: Keeps) {
    this.paths = read(kept.getItem(RECENTS_KEY));
  }

  /** Every workspace kept, most recently opened first. */
  get all(): readonly string[] {
    return this.paths;
  }

  /** opened puts a workspace at the top: it was opened, or saved, just now. */
  opened(path: string): void {
    this.keep([path, ...this.paths.filter((p) => p !== path)].slice(0, RECENTS_MAX));
  }

  /** forget takes a workspace off the list. The file is left where it is. */
  forget(path: string): void {
    this.keep(this.paths.filter((p) => p !== path));
  }

  private keep(paths: string[]): void {
    this.paths = paths;
    this.kept.setItem(RECENTS_KEY, JSON.stringify(paths));
  }
}

/**
 * read is the list as it was kept. Anything else in its place -- nothing, a
 * value another build wrote, a file edited by hand -- reads as an empty list,
 * since a list of recents is not worth refusing to start over.
 */
function read(kept: string | null): string[] {
  if (kept === null) return [];
  try {
    const value: unknown = JSON.parse(kept);
    if (!Array.isArray(value)) return [];
    const paths = value.filter((p): p is string => typeof p === "string" && p !== "");
    return [...new Set(paths)].slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}
