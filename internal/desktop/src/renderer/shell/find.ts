// Finding in a column: ]f and [f for the cells that do not parse, / and ? for
// text, and n and N for the last search again.
//
// The engine reads the file for each, so a find reaches rows no band holds.

import type { FindRequest } from "@uno/grid/engine";

import type { Grid } from "../grid/index.ts";
import type { Workspace } from "../workspace.ts";
import { message } from "./util.ts";

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
      this.say(`${column.header} is text · every value in it parses`, true);
      return;
    }
    const where = `${dir === 1 ? "below" : "above"} row ${(row + 1).toLocaleString()}`;
    const kind = column.kind === "date" ? "a date" : "a number";
    void this.find(
      { t: "unparsed" },
      dir,
      `nothing ${where} in ${column.header} fails to parse as ${kind}`,
    );
  }

  /**
   * search is / and ?: the next cell down or up this column that shows some
   * text. Enter on nothing searches for the last text again, as vim does.
   */
  search(typed: string, dir: 1 | -1): void {
    const text = typed === "" ? this.searched?.text : typed;
    if (text === undefined) {
      this.say("nothing searched yet", true);
      return;
    }
    this.searched = { text, dir };
    this.searchFor(text, dir);
  }

  /** next is n and N: the last search again, the same way or the other. */
  next(reverse: boolean): void {
    const last = this.searched;
    if (last === undefined) {
      this.say("nothing searched yet", true);
      return;
    }
    this.searchFor(last.text, reverse === (last.dir === 1) ? -1 : 1);
  }

  private searchFor(text: string, dir: 1 | -1): void {
    const on = this.showing();
    if (on === undefined) return;
    const { row, col } = on.grid.selection();
    const header = on.workspace.rows.columns[col]?.header ?? "this column";
    const where = `${dir === 1 ? "below" : "above"} row ${(row + 1).toLocaleString()}`;
    void this.find({ t: "text", text }, dir, `"${text}" is not ${where} in ${header}`);
  }

  /**
   * find asks the engine for the next row down or up this column that matches,
   * and selects it. `missing` is what to say when there is none.
   */
  private async find(match: FindRequest["match"], dir: 1 | -1, missing: string): Promise<void> {
    const on = this.showing();
    if (on === undefined) return;
    const { workspace: w, grid } = on;
    const { row, col } = grid.selection();
    const asked = ++this.finds;

    // Most finds answer within a frame. Saying so only for one that does not
    // keeps the status bar from blinking on every ]f.
    const slow = setTimeout(() => this.say("searching…"), 200);
    try {
      const found = await w.find({ col, from: row, dir, match });
      if (asked !== this.finds || this.showing()?.workspace !== w) return;
      if (found.row !== null) {
        grid.moveTo(found.row, col);
        this.say("");
      } else if (found.complete) {
        this.say(missing, true);
      } else {
        const searched = found.searched.toLocaleString();
        this.say(`${missing} · searched ${searched} rows · indexing ${w.indexed()}%`, true);
      }
    } catch (err) {
      if (asked === this.finds) this.say(message(err), true);
    } finally {
      clearTimeout(slow);
    }
  }
}
