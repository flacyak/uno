/**
 * @fileoverview A chart is a window over the sheet that plots one source's
 * columns. view/charts.json keeps its record and a `chart` request carries it.
 */

/**
 * The most charts a workspace keeps, carried ones included. Sixteen windows
 * of a new chart's size, four by four, fill most of a full HD screen.
 */
export const CHARTS_AT_MOST = 16;

/** The longest title: a long sentence, counted as an input's maxlength does. */
export const TITLE_AT_MOST = 200;

/** The longest wait between scheduled checks of a source: one week. */
export const REFRESH_MINUTES_AT_MOST = 7 * 24 * 60;

/**
 * The decimals a saved x or y keeps, so a window that has not moved saves the
 * same bytes. Four keep it within a px in any room under 10,000 px.
 */
export const PLACE_DIGITS = 4;

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

/**
 * Where a chart's window sits. width and height are CSS px. x and y are
 * fractions (0..1) of the room left beside and below the window, so a window
 * at the right edge stays at the right edge on any screen.
 */
export interface ChartPlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Chart {
  /** Unique in the workspace. uno makes 'c1', 'c2', ..., and reads any name. */
  id: string;
  /** The source's id, as Opened.source names it. */
  source: string;
  plot: Plot;
  /** The person's title, or '' for the one the plot makes. */
  title: string;
  place: ChartPlace;
  /** Minutes between scheduled checks of the source. 0 is by hand only. */
  refresh: number;
}

/** A chart parseChart refuses, such as a newer build's, kept as its JSON. */
export interface CarriedChart {
  /** The source it names, or '' for none, so it can go with its source. */
  source: string;
  json: string;
}
