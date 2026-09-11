// What a check can ask of a running app, without knowing whether that app is a
// real Electron window or something standing in for one.
//
// Every operation here is a fact a person could ask about a spreadsheet on
// screen -- what a label says, how many of something there are, what a row
// looks like -- and every answer is a plain value: text, a count, a boolean, a
// `Row`. No `Element` or `HTMLElement` crosses this interface in either
// direction, so a backend that never built a document could still answer
// honestly, and a check written against `Page` never has to know which kind of
// backend it got.
//
// A check that needs more than this -- real layout, the real preload bridge, a
// person's own input reaching (or not reaching) the page -- is not a gap in
// this list to fill in later. It is a check that stays a string, run the old
// way. See check.ts.

/** One row as the grid draws it. */
export interface Row {
  /** The gutter's own label: the row's number, as text. */
  gutter: string;
  /** The row's class list, exactly as the DOM has it: "", "even", "pending",
   * or "even pending". */
  className: string;
  /** Each column's cell, in order, after the gutter. */
  cells: string[];
}

/** The modifiers a check presses a key with. */
export interface KeyModifiers {
  ctrlKey?: boolean;
}

/** Where a `Wait` looks: a selector's first match, or a drawn cell by row and
 * column -- `col` counted the way `Row.cells` counts them, after the gutter. */
export type Locator = { selector: string } | { row: number; col: number };

/** What a `Wait` requires to be true there. */
export type Expectation = { equals: string } | { includes: string };

/** One condition a wait polls for. `Page.until` ANDs every one of these
 * together, and does not report until they all hold or the budget runs out. */
export type Wait = Locator & Expectation;

export interface Page {
  /** Whether the preload bridge exposed itself: whether `window.uno.open` is a function. */
  bridgeExposed(): Promise<boolean>;

  /** The text at the first match of `selector`, or "" when there is none. */
  text(selector: string): Promise<string>;
  /** The text of every match of `selector`, in document order. */
  allText(selector: string): Promise<string[]>;
  /** Each match's own text, before any element nested inside it -- a column
   * header's name, say, without the badge drawn beside it. */
  ownText(selector: string): Promise<string[]>;
  /** How many elements match `selector`. */
  count(selector: string): Promise<number>;
  /** Whether the match at `index` (the first, by default) carries `className`. */
  hasClass(selector: string, className: string, index?: number): Promise<boolean>;
  /** Whether the first match of `selector` is hidden. */
  hidden(selector: string): Promise<boolean>;

  /** The drawn rows, top to bottom, as the virtualiser currently holds them. */
  rows(): Promise<Row[]>;

  /** Click the cell at `row`, `col` among the drawn rows -- `col` is 0 for the
   * first column after the gutter, the way `Row.cells` counts them. */
  clickCell(row: number, col: number): Promise<void>;
  /** Click the first match of `selector`. */
  click(selector: string): Promise<void>;

  /** The open cell editor's value, or undefined when none is open. */
  editorValue(): Promise<string | undefined>;
  /** Set the open cell editor's value, without committing it. */
  setEditorValue(value: string): Promise<void>;

  /** Press a key, routed the way a real one would be: to the cell editor while
   * one is open, to the grid otherwise. */
  press(key: string, modifiers?: KeyModifiers): Promise<void>;

  /** Let this many animation frames pass. */
  settle(frames: number): Promise<void>;

  /**
   * Poll until every `Wait` holds, or give up after the shared budget and
   * report which.
   *
   * The whole loop runs in one round trip to the page, because a check waiting
   * on a frame-by-frame condition must not pay one evaluate per frame -- at up
   * to 150 frames a wait, that is the difference between a smoke run and a
   * nap. A backend answers this by looping inside its own evaluate, not by
   * calling back out to whatever asked.
   */
  until(waits: Wait[]): Promise<boolean>;

  /** Scroll the grid to a pixel offset. */
  scrollTo(top: number): Promise<void>;
}
