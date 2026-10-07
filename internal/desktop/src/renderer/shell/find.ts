// Finding in a column: ]f and [f for the cells that do not parse, / and ? for
// text, and n and N for the last search again.
//
// The engine reads the file for each, so a find reaches rows no band holds.

import type { FindRequest } from "@uno/grid/engine";

import { m } from "../../paraglide/messages.js";
import { columnLabel } from "../grid/rows.ts";
import type { Grid } from "../grid/index.ts";
import { num } from "../locale.ts";
import type { Workspace } from "../workspace.ts";
import { message } from "./util.ts";

/** How long a find may take before the status bar says it is searching. */
const SLOW_MS = 200;

/** The open workspace and the grid showing it. */
export interface Showing {
  workspace: Workspace;
  grid: Grid;
}

export class Finder {
  /** Counts finds, so the answer to one a person has since asked again over is dropped. */
  private finds = 0;
  /** The last text searched for, and which way, for n and N. */
  private searched: { text: string; dir: 1 | -1 } | undefined;

  constructor(
    private readonly showing: () => Showing | undefined,
    private readonly say: (text: string, isError?: boolean) => void,
  ) {}

  /**
   * unparsed is ]f and [f: the next cell down or up this column that does not
   * parse as its badge says it should. Fixing those is what uno is for.
   */
  unparsed(dir: 1 | -1): void {
    const on = this.showing();
    if (on === undefined) return;
    const { row, col } = on.grid.selection();
    const column = on.workspace.rows.columns[col];
    if (column === undefined) return;

    // Plain text has nothing in it to fail, and reading the file to say so
    // would be slow for nothing.
    if (column.kind === "text" && !column.flagged) {
      this.say(m.find_column_is_text({ column: columnLabel(column.header, col) }), true);
      return;
    }
    const from = { row: num(row + 1), column: columnLabel(column.header, col) };
    const missing =
      column.kind === "date"
        ? dir === 1
          ? m.find_unparsed_date_below(from)
          : m.find_unparsed_date_above(from)
        : dir === 1
          ? m.find_unparsed_number_below(from)
          : m.find_unparsed_number_above(from);
    void this.find({ t: "unparsed" }, dir, missing);
  }

  /**
   * search is / and ?: the next cell down or up this column that shows some
   * text. Enter on nothing searches for the last text again, as vim does.
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

  /** next is n and N: the last search again, the same way or the other. */
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
    const from = { text, row: num(row + 1), column: header };
    void this.find(
      { t: "text", text },
      dir,
      dir === 1 ? m.find_text_below(from) : m.find_text_above(from),
    );
  }

  /**
   * find asks the engine for the next row down or up this column that matches,
   * and selects it. `missing` is what to say when there is none.
   */
  private async find(match: FindRequest["match"], dir: 1 | -1, missing: string): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    // The find reads the tab showing now, and the row it finds is a row of
    // that tab: one the person has since left is not moved to in the other.
    const tab = w.active;
    const { row, col } = grid.selection();
    const asked = ++this.finds;

    // Most finds answer within a frame. Saying so only for one that does not
    // keeps the status bar from blinking on every ]f.
    let spoke = false;
    const slow = setTimeout(() => {
      spoke = true;
      this.say(m.searching());
    }, SLOW_MS);
    try {
      const found = await w.find({ col, from: row, dir, match });
      // A newer find speaks for itself, over whatever this one said.
      if (asked !== this.finds) return;
      if (this.showing()?.workspace !== w || w.active !== tab) {
        // The answer is to a tab since left, and so is what was said of it.
        if (spoke) this.say("");
        return;
      }
      if (found.row !== null) {
        grid.moveTo(found.row, col);
        this.say("");
      } else if (found.complete) {
        this.say(missing, true);
      } else {
        const parts = [
          missing,
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
