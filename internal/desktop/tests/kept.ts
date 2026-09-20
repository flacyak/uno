/**
 * @fileoverview A stand-in for localStorage, backed by a Map.
 */

import type { Keeps } from "#renderer/theme";

export class Kept implements Keeps {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}
