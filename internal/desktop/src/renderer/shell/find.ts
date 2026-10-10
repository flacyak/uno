// Find in a column: ]f and [f for cells that fail to parse, / and ? for text,
// and n and N to repeat the last search.
//
// The engine answers each find by reading the file, so a find reaches rows
// beyond what the grid has loaded.

import type { FindRequest } from "@uno/grid/engine";

import { m } from "../../paraglide/messages.js";
import { columnLabel } from "../grid/rows.ts";
import type { Grid } from "../grid/index.ts";
import { num } from "../locale.ts";
import type { Workspace } from "../workspace.ts";
import { message } from "./util.ts";

/** How long a find may take before the status bar says "searching". */
const SLOW_MS = 200;

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
    const missing =
      column.kind === "date"
        ? dir === 1
          ? m.find_unparsed_date_below
          : m.find_unparsed_date_above
        : dir === 1
          ? m.find_unparsed_number_below
          : m.find_unparsed_number_above;
    void this.find({ t: "unparsed" }, dir, () => missing({ row: num(row + 1), column: header }));
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
   * find asks the engine for the next matching row down or up this column and
   * selects it. `missing` builds the message shown when there is none. It is
   * called when the message is shown, so it is in the current language.
   */
  private async find(
    match: FindRequest["match"],
    dir: 1 | -1,
    missing: () => string,
  ): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    // The find is for the active tab. If the tab changes before the answer
    // lands, the result is dropped.
    const tab = w.active;
    const { row, col } = grid.selection();
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
      if (asked !== this.finds) return;
      if (this.showing()?.workspace !== w || w.active !== tab) {
        // The tab or workspace changed. Clear what this find said.
        if (spoke) this.say("");
        return;
      }
      if (found.row !== null) {
        grid.moveTo(found.row, col);
        this.say("");
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
    } catch (err) {
      if (asked === this.finds) this.say(message(err), true);
    } finally {
      clearTimeout(slow);
    }
  }
}
