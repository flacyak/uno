/**
 * @fileoverview Gives a JSON Lines file's keys their columns, in the order
 * the keys are first seen.
 *
 * A key is an RFC 6901 pointer to a cell, and identifies its column. A
 * column's name is its pointer's segments joined by '.', made unique against
 * every name already taken by headerOf's suffix rule, and never changes once
 * given. A reopen seeds the registry with the columns a save pinned, so a key
 * finds its column again wherever it first turns up.
 */

import { suffixed } from './format.ts';
import { segmentsOf } from './json.ts';

/** How many columns keys may take in one JSON Lines file. */
export const JSON_COLUMNS_LIMIT = 1024;
/** What a column's name puts between its pointer's segments. */
const SEGMENT_JOIN = '.';

/**
 * KeyedColumn is a column found by key: the name the header shows, unique in
 * its source and never renamed, and the RFC 6901 pointer to its cells.
 */
export interface KeyedColumn {
  readonly name: string;
  readonly key: string;
}

/**
 * nameOf returns the name a key's column asks for: the pointer's segments,
 * unescaped, joined by '.'. /user/name asks for user.name, and /a~1b for a/b.
 */
function nameOf(key: string): string {
  return segmentsOf(key).join(SEGMENT_JOIN);
}

/**
 * KeyRegistry places each key in a column of its own, in the order keys are
 * first seen, while keys hold fewer columns than its limit.
 */
export class KeyRegistry {
  /** Every column so far, in order. */
  private readonly all: KeyedColumn[] = [];
  /** Each key's column. */
  private readonly places = new Map<string, number>();
  /** Every name a column holds. */
  private readonly taken = new Set<string>();
  /** How many columns keys may hold. */
  private readonly limit: number;

  /**
   * The registry starts with `pinned` in their places, each with its name, so
   * a key claims its pinned column when it first appears. A key pinned twice
   * keeps its first column. `limit` is how many columns keys may hold.
   */
  constructor(pinned: readonly KeyedColumn[], limit: number) {
    this.limit = limit;
    for (const column of pinned) this.add(column);
  }

  /** columns returns the columns so far, in order. */
  columns(): readonly KeyedColumn[] {
    return this.all;
  }

  /**
   * place returns the column for `key`: its own, or a new one at the end while
   * keys hold fewer columns than the limit. Undefined past the limit.
   */
  place(key: string): number | undefined {
    const known = this.places.get(key);
    if (known !== undefined) return known;
    if (this.all.length >= this.limit) return undefined;
    return this.add({ name: this.unique(nameOf(key)), key });
  }

  /** columnOf returns the column for `key` and adds none, for a decode. */
  columnOf(key: string): number | undefined {
    return this.places.get(key);
  }

  /** unique returns `name`, or it with headerOf's suffix when it is taken. */
  private unique(name: string): string {
    return this.taken.has(name) ? suffixed(name, this.taken) : name;
  }

  /** add puts `column` at the end and returns its place. */
  private add(column: KeyedColumn): number {
    const at = this.all.length;
    this.all.push(column);
    this.taken.add(column.name);
    if (!this.places.has(column.key)) this.places.set(column.key, at);
    return at;
  }
}
