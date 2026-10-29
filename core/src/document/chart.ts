/**
 * @fileoverview A chart is a window over the sheet that plots one source's
 * columns. view/charts.json keeps its record and a `chart` request carries it.
 */

/**
 * A column a chart reads: its place, and its header when the chart was made,
 * so a relink can be checked.
 */
export interface ChartColumn {
  col: number;
  header: string;
}

/** What a chart draws. This is all the engine needs to tally it. */
export type Plot =
  /** No `sum`: count rows per value. */
  | { t: 'bars'; by: ChartColumn; sum?: ChartColumn }
  /** Each value's share of the rows, or of the sum of `sum`. */
  | { t: 'pie'; by: ChartColumn; sum?: ChartColumn }
  /** One point per row, x against y, both number columns. */
  | { t: 'scatter'; x: ChartColumn; y: ChartColumn };
