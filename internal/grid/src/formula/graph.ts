import { compareStrings } from "../go/index.ts";
import type { Formula } from "./ast.ts";

/**
 * Graph is the dependency graph of the bound columns: one node per column,
 * named by header. A fresh Graph is empty.
 */
export class Graph {
  // deps maps each bound column to the columns its formula reads.
  private readonly deps = new Map<string, string[]>();

  /**
   * bind records that `col` is computed from `f`. It throws if that would
   * make a cycle, naming every column on the loop.
   */
  bind(col: string, f: Formula): void {
    const deps = f.refs();
    const path = this.wouldCycle(col, deps);
    if (path !== undefined) {
      throw new Error(`${col} would depend on itself: ${path.join(" → ")}`);
    }
    this.deps.set(col, deps);
  }

  /**
   * unbind removes a column's edges.
   */
  unbind(col: string): void {
    this.deps.delete(col);
  }

  /**
   * downstreamOf returns the columns that depend on `col`, directly or
   * transitively, ordered so each comes after the ones it reads. `col`
   * itself is left out.
   */
  downstreamOf(col: string): string[] {
    // Reverse the edges to find dependents.
    const rev = new Map<string, string[]>();
    for (const [c, ds] of this.deps) {
      for (const d of ds) {
        const to = rev.get(d);
        if (to === undefined) rev.set(d, [c]);
        else to.push(c);
      }
    }

    const down = new Set<string>();
    const collect = (at: string): void => {
      for (const c of rev.get(at) ?? []) {
        if (!down.has(c)) {
          down.add(c);
          collect(c);
        }
      }
    };
    collect(col);

    // A column is emitted after every column it reads that is also
    // downstream of the change.
    return this.postOrder(down, (d) => down.has(d));
  }

  /**
   * order returns every bound column, each after the bound columns it reads.
   */
  order(): string[] {
    return this.postOrder(this.deps.keys(), (d) => this.deps.has(d));
  }

  /**
   * postOrder walks the forward edges from each of `from`, following only
   * those `kept` allows, and emits a column after every column it reads.
   * The start set is sorted so the order is stable. The walk ends because
   * bind refuses cycles.
   */
  private postOrder(from: Iterable<string>, kept: (col: string) => boolean): string[] {
    const out: string[] = [];
    const done = new Set<string>();
    const emit = (c: string): void => {
      if (done.has(c)) return;
      done.add(c);
      for (const d of this.deps.get(c) ?? []) {
        if (kept(d)) emit(d);
      }
      out.push(c);
    };
    for (const c of [...from].sort(compareStrings)) emit(c);
    return out;
  }

  /**
   * wouldCycle walks from each of `deps` looking for `col`. It returns the
   * path from `col` back to itself, or undefined when `col` stays unreached.
   */
  private wouldCycle(col: string, deps: string[]): string[] | undefined {
    const path: string[] = [];
    const seen = new Set<string>();

    const walk = (at: string): boolean => {
      path.push(at);
      if (at === col) return true;
      if (!seen.has(at)) {
        seen.add(at);
        for (const d of this.deps.get(at) ?? []) {
          if (walk(d)) return true;
        }
      }
      path.pop();
      return false;
    };

    for (const d of deps) {
      if (walk(d)) return [col, ...path];
    }
    return undefined;
  }
}
