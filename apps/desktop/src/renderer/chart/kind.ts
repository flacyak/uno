/**
 * @fileoverview What a chart window does that depends on its kind, so a kind
 * is one module behind one interface, and one entry in a table the compiler
 * checks.
 */

import type { ChartColumn, Plot } from "@document";
import type { Tally } from "@engine";
import type { Told } from "./summary.ts";
import type { Targets } from "./tooltip.ts";

/** A tally a chart can draw: any but why its source could not be read. */
export type Drawn = Exclude<Tally, { t: "unread" }>;

/**
 * The room a plot gives its drawing, as the window measures it: its width,
 * and a tick's character, which a mono label takes its length in. Both in px.
 */
export interface PlotRoom {
  readonly width: number;
  readonly ch: number;
}

/** What a window draws of one tally, as its chart's kind reads it. */
export interface Drawing {
  /** Whether the tally holds nothing to draw. */
  readonly empty: boolean;
  /** draw gives the drawing at the plot's `height`, nothing in it measured. */
  draw(height: number): HTMLElement;
  /** fit fits the drawing once it stands in the plot: values, an axis, labels. */
  fit(drawn: HTMLElement): void;
  /** targets gives the drawing's marks, for the tooltip and the keys. */
  targets(drawn: HTMLElement): Targets;
  /** table gives the tally as a table under a caption of `called`. */
  table(called: Node): HTMLElement;
  /** told gives what the summary says of the tally past its rows. */
  told(): Told;
  /** notes gives what the caption says after its counts, for the kind. */
  notes(): string[];
}

/** What a window does with one plot that depends on its kind. */
export interface Kind {
  /** title gives the title the plot makes, in the app's language. */
  title(): string;
  /** The columns it reads numbers from, which not-numbers finds. */
  readonly numbered: readonly ChartColumn[];
  /** The columns its values come from, which the plot names before any. */
  readonly valued: readonly ChartColumn[];
  /**
   * drawing reads `tally` for the plot, to draw in `room`, or is undefined of
   * another kind's.
   */
  drawing(tally: Drawn, room: PlotRoom): Drawing | undefined;
}

/** A kind of chart, as what it does with each plot of it. */
export type ChartKind<P extends Plot> = (plot: P) => Kind;

/** The kind of each plot. A plot with none fails the build. */
export type Kinds = {
  readonly [K in Plot["t"]]: ChartKind<Extract<Plot, { t: K }>>;
};

/** kindOf is what `kinds` does with `plot`, of kind `t`. */
export function kindOf<K extends Plot["t"]>(
  kinds: Kinds,
  t: K,
  plot: Extract<Plot, { t: K }>,
): Kind {
  return kinds[t](plot);
}
