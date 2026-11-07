/**
 * @fileoverview Find in a column: ]f and [f for cells that fail to parse, / and
 * ? for text, n and N to repeat the last search, and a chart's not numbers.
 *
 * The engine answers each find by reading the file, so a find reaches rows
 * beyond what the grid has loaded.
 */

import type { ChartColumn } from "@document";
import { placeOf } from "@engine";
import type { FindRequest } from "@engine";

import { m } from "@paraglide/messages";
import { columnLabel } from "@renderer/grid/rows";
import type { Grid } from "@renderer/grid";
import { num } from "@renderer/locale";
import type { Workspace } from "@renderer/workspace";
import { message } from "./util.ts";

/** How long a find may take before the status bar says "searching". */
const SLOW_MS = 200;

/**
 * The first row, and the row a search of a whole column starts beside, as
 * matching starts at the next.
 */
const FIRST_ROW = 0;
const ABOVE_FIRST_ROW = FIRST_ROW - 1;

/**
 * How a find ended: on the row it found, with none, dropped for a newer find
 * or a tab the person left, or failed, which the status bar says.
 */
type Ending = "found" | "missed" | "dropped" | "failed";

/** The open workspace and the grid showing it. */
export interface Showing {
  workspace: Workspace;
  grid: Grid;
}

export class Finder {
  /** Counts finds, so the answer to a superseded find is dropped. */
  private finds = 0;
  /** The last text searched for and its direction, for n and N. */
  private searched: { text: string; dir: 1 | -1 } | undefined;

  constructor(
    private readonly showing: () => Showing | undefined,
    private readonly say: (text: string, isError?: boolean) => void,
  ) {}

  /**
   * unparsed is ]f and [f: moves to the next cell down or up this column that
   * fails to parse as its column's kind.
   */
  unparsed(dir: 1 | -1): void {
    const on = this.showing();
    if (on === undefined) return;
    const { row, col } = on.grid.selection();
    const column = on.workspace.rows.columns[col];
    if (column === undefined) return;

    // Every cell of a plain text column parses.
    if (column.kind === "text" && !column.flagged) {
      this.say(m.find_column_is_text({ column: columnLabel(column.header, col) }), true);
      return;
    }
    const header = columnLabel(column.header, col);
    const below = dir === 1;
    let missing: typeof m.find_unparsed_date_below;
    if (column.kind === "date") {
      missing = below ? m.find_unparsed_date_below : m.find_unparsed_date_above;
    } else {
      missing = below ? m.find_unparsed_number_below : m.find_unparsed_number_above;
    }
    void this.find({ t: "unparsed" }, dir, () => missing({ row: num(row + 1), column: header }));
  }

  /**
   * notNumbers is a chart's "3 not numbers": moves to the first cell down the
   * first of `columns` to have one that the tally could not read as a number.
   * It finds each column among the tab's as the engine does for the tally.
   * Only a miss goes on to the next column: a find dropped, for a tab the
   * person left or a find of their own over it, is the search's last.
   */
  async notNumbers(columns: readonly ChartColumn[]): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace, grid } = on;
    const headers = workspace.rows.columns.map((c) => c.header);
    for (const wanted of columns) {
      const col = placeOf(wanted, headers);
      if (col === undefined) continue;
      grid.moveTo(FIRST_ROW, col);
      const column = columnLabel(wanted.header, col);
      const missing = () => m.find_unparsed_number_below({ row: num(FIRST_ROW + 1), column });
      const from = { row: ABOVE_FIRST_ROW, col };
      const ending = await this.find({ t: "not-number" }, 1, missing, from);
      if (ending !== "missed") return;
    }
  }

  /**
   * search is / and ?: moves to the next cell down or up this column whose
   * text matches. Empty input repeats the last search.
   */
  search(typed: string, dir: 1 | -1): void {
    const text = typed === "" ? this.searched?.text : typed;
    if (text === undefined) {
      this.say(m.nothing_searched(), true);
      return;
    }
    this.searched = { text, dir };
    this.searchFor(text, dir);
  }

  /**
   * next is n and N: repeats the last search, in the same or the opposite
   * direction.
   */
  next(reverse: boolean): void {
    const last = this.searched;
    if (last === undefined) {
      this.say(m.nothing_searched(), true);
      return;
    }
    this.searchFor(last.text, reverse === (last.dir === 1) ? -1 : 1);
  }

  private searchFor(text: string, dir: 1 | -1): void {
    const on = this.showing();
    if (on === undefined) return;
    const { row, col } = on.grid.selection();
    const column = on.workspace.rows.columns[col];
    const header = column === undefined ? m.this_column() : columnLabel(column.header, col);
    const missing = dir === 1 ? m.find_text_below : m.find_text_above;
    void this.find({ t: "text", text }, dir, () =>
      missing({ text, row: num(row + 1), column: header }),
    );
  }

  /**
   * find asks the engine for the next matching row down or up a column, from
   * beside `at` or the selected cell, selects it, says whether it found one,
   * and gives how it ended. `missing` builds the message for none when it is
   * shown, in the language then.
   */
  private async find(
    match: FindRequest["match"],
    dir: 1 | -1,
    missing: () => string,
    at?: { row: number; col: number },
  ): Promise<Ending> {
    const on = this.showing();
    if (on === undefined) return "dropped";
    const { workspace: w, grid } = on;
    // The find is for the active tab. If the tab changes before the answer
    // lands, the result is dropped.
    const tab = w.active;
    const { row, col } = at ?? grid.selection();
    const asked = ++this.finds;

    // Say "searching" only when the find takes longer than SLOW_MS.
    let spoke = false;
    const slow = setTimeout(() => {
      spoke = true;
      this.say(m.searching());
    }, SLOW_MS);
    try {
      const found = await w.find({ col, from: row, dir, match });
      // A newer find has superseded this one.
      if (asked !== this.finds) return "dropped";
      if (this.showing()?.workspace !== w || w.active !== tab) {
        // The tab or workspace changed. Clear what this find said.
        if (spoke) this.say("");
        return "dropped";
      }
      if (found.row !== null) {
        grid.moveTo(found.row, col);
        this.say("");
        return "found";
      } else if (found.complete) {
        this.say(missing(), true);
      } else {
        const parts = [
          missing(),
          m.find_searched_rows({ count: found.searched }),
          m.indexing_percent({ percent: w.indexed() }),
        ];
        this.say(parts.join(" · "), true);
      }
      return "missed";
    } catch (err) {
      if (asked !== this.finds) return "dropped";
      this.say(message(err), true);
      return "failed";
    } finally {
      clearTimeout(slow);
    }
  }
}
