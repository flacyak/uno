import { compareStrings } from "../go/index.ts";
import type { Formula } from "./ast.ts";

/**
 * Graph is the dependency graph of the bound columns.
 *
 * Columns depend on columns, so the graph is tiny: one node per column, not one
 * per cell. A general spreadsheet lets any cell name any cell, which on the
 * sample sheet is 28,872 nodes and a partial re-evaluation over them for every
 * edit -- a real engine, and the reason recalculation is a famously hard
 * problem. Whole-column scope collapses that to six nodes here and twenty in a
 * wide export, where a topological sort is a few lines and cycle detection is
 * the same walk.
 *
 * Nodes are named by column name rather than by an index or an ID because
 * `sheet` owns header-to-index resolution and `formula` stays sheet-free. It is
 * also the name a person reads in a refused binding.
 *
 * A fresh Graph holds nothing bound, so a workspace with no formulas is a graph
 * rather than a special case.
 */
export class Graph {
  // deps holds edges, not formulas. What a column resolves to is sheet state --
  // it is saved in the .uno and reloaded from it -- and a second home for it
  // here would be a second thing to keep in step.
  private readonly deps = new Map<string, string[]>();

  /**
   * bind records that col is computed from f, and refuses a cycle.
   *
   * Refusing here is the whole point: a cycle found during a recalculation is
   * found with half a column already written, and the only thing left to say
   * about it is that something went wrong somewhere. Found at bind time it is
   * one person, one expression, and a path that names every step of the loop.
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
   * unbind drops a column's edges, and is what the sheet calls when a formula
   * is taken off a column.
   *
   * Deleting rather than emptying is what keeps the cycle check honest
   * afterwards. A column nothing computes any more is a column whose old
   * dependencies are no longer a path anywhere, and leaving them behind would
   * let a removed formula refuse a binding somebody makes a week later, naming
   * a loop that does not exist.
   */
  unbind(col: string): void {
    this.deps.delete(col);
  }

  /**
   * downstreamOf returns the columns that have to be recalculated after col
   * changes, in an order where nothing is computed before what it reads.
   *
   * It is the columns downstream of the change and not every bound column,
   * because a recalculation that touched all of them would do work proportional
   * to the sheet rather than to the edit. col itself is not in the list: it is
   * what changed, not what follows from the change.
   */
  downstreamOf(col: string): string[] {
    // Dependents, transitively. Reversing the edges once per call is cheap at
    // twenty nodes and leaves one representation to keep correct instead of two.
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

    // Post-order over the forward edges: a column is emitted after every column
    // it reads that is also downstream of the change. This terminates without a
    // visited-in-progress guard because bind refuses cycles, which is the
    // second thing that check buys.
    const out: string[] = [];
    const done = new Set<string>();
    const emit = (c: string): void => {
      if (done.has(c)) return;
      done.add(c);
      for (const d of this.deps.get(c) ?? []) {
        if (down.has(d)) emit(d);
      }
      out.push(c);
    };

    // The starting order is fixed, so a graph that is bound the same way twice
    // recalculates in the same order twice. A JavaScript Map iterates in
    // insertion order, which is deterministic and is not the order the Go
    // sorts into -- keeping the sort is what keeps the two builds agreeing.
    for (const c of [...down].sort(compareStrings)) emit(c);
    return out;
  }

  /**
   * order returns every bound column, each after the bound columns it reads.
   *
   * A row is finished by computing its bound columns in this order, so a column
   * that reads another bound column reads what that column computed. The start
   * is sorted for the reason `downstreamOf`'s is.
   */
  order(): string[] {
    const out: string[] = [];
    const done = new Set<string>();
    const emit = (c: string): void => {
      if (done.has(c)) return;
      done.add(c);
      for (const d of this.deps.get(c) ?? []) {
        if (this.deps.has(d)) emit(d);
      }
      out.push(c);
    };
    for (const c of [...this.deps.keys()].sort(compareStrings)) emit(c);
    return out;
  }

  /**
   * wouldCycle walks from each proposed dependency looking for col, and returns
   * the path it got there by.
   *
   * The path is the answer, not the boolean: "margin would depend on itself" is
   * a puzzle, and "margin → price → margin" is the two edits that fix it.
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
