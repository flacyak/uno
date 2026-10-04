// The list of recently opened workspace paths, most recent first. The
// sidebar shows it.
//
// A .uno path is added when it is opened or saved. The list is kept in local
// storage and holds only paths. A path deleted since is only found out
// when it is opened.

import type { Keeps } from "./theme.ts";

/** Storage key for the list. */
export const RECENTS_KEY = "uno.recents";

/** Maximum list length. The oldest entry is dropped first. */
export const RECENTS_MAX = 30;

export class Recents {
  private paths: string[];

  constructor(private readonly kept: Keeps) {
    this.paths = read(kept.getItem(RECENTS_KEY));
  }

  /** All kept paths, most recently opened first. */
  get all(): readonly string[] {
    return this.paths;
  }

  /** Moves a path to the top of the list, adding it if needed. */
  opened(path: string): void {
    this.keep([path, ...this.paths.filter((p) => p !== path)].slice(0, RECENTS_MAX));
  }

  /** Removes a path from the list. The file itself is untouched. */
  forget(path: string): void {
    this.keep(this.paths.filter((p) => p !== path));
  }

  private keep(paths: string[]): void {
    this.paths = paths;
    this.kept.setItem(RECENTS_KEY, JSON.stringify(paths));
  }
}

/**
 * Parses the stored list. Missing or malformed storage returns an empty
 * list. Duplicates and empty strings are dropped.
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
