// The status bar: the mode, the file, the one line the shell talks on, keys
// waiting for more, and where the selection is.
//
// It also holds the prompt: a command after :, a search after / or ?. While the
// prompt is open it stands in for the file's line.
//
// The window's switches are at its ends: the one that opens and closes the
// sidebar on the left, and on the right the one between view and transform and
// the one that opens the sources panel.

import "./status.css";

import { m } from "../../paraglide/messages.js";
import type { Grid } from "../grid/index.ts";
import type { InputStrategy } from "../input/index.ts";
import type { Lead } from "../keys.ts";
import { num } from "../locale.ts";
import type { Workspace } from "../workspace.ts";
import { must } from "./util.ts";

/** What the bar's switches do. The shell decides; the bar only asks. */
export interface StatusAsks {
  /** Move between view and transform. */
  toggleMode(): void;
  /** Open or close the sidebar. */
  toggleSidebar(): void;
  /** Open or close the sources panel. */
  togglePanel(): void;
}

/** Which of the window's columns are open, for the switches to say. */
export interface Columns {
  sidebar: boolean;
  panel: boolean;
}

export class StatusBar {
  /** What the open prompt began with. */
  private lead: Lead = ":";

  private readonly bar = must(document.querySelector<HTMLElement>(".win-status"));
  private readonly mode = must(document.querySelector<HTMLElement>("#status-mode"));
  private readonly file = must(document.querySelector<HTMLElement>("#status-file"));
  private readonly msg = must(document.querySelector<HTMLElement>("#status-msg"));
  private readonly waiting = must(document.querySelector<HTMLElement>("#status-keys"));
  private readonly cmd = must(document.querySelector<HTMLInputElement>("#status-cmd"));
  private readonly cell = must(document.querySelector<HTMLElement>("#status-cell"));
  private readonly seg = must(document.querySelector<HTMLElement>("#mode-switch"));
  private readonly side = must(document.querySelector<HTMLButtonElement>("#sidebar-toggle"));
  private readonly sources = must(document.querySelector<HTMLButtonElement>("#panel-toggle"));

  /**
   * Enter runs what was typed and Esc closes the prompt, as do clicking away and
   * deleting the character it opened with.
   */
  constructor(
    /** Enter in the prompt: what it began with, and what was typed after that. */
    private readonly entered: (lead: Lead, typed: string) => void,
    /** The prompt closed, so the keys go back to the grid. */
    private readonly closed: () => void,
    asks: StatusAsks,
  ) {
    for (const option of this.seg.querySelectorAll<HTMLElement>("[data-mode]")) {
      // The option showing is where the workspace already is.
      option.addEventListener("click", () => {
        if (!option.classList.contains("on")) asks.toggleMode();
      });
    }
    this.side.addEventListener("click", () => asks.toggleSidebar());
    this.sources.addEventListener("click", () => asks.togglePanel());

    const input = this.cmd;
    input.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is being typed.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const typed = input.value.slice(1);
        this.close();
        this.entered(this.lead, typed);
      }
    });
    input.addEventListener("input", () => {
      if (!input.value.startsWith(this.lead)) this.close();
    });
    input.addEventListener("blur", () => this.close());
  }

  /**
   * paint says what is open, which mode it is in, where the selection is, and
   * which of the window's columns are open.
   */
  paint(
    w: Workspace | undefined,
    grid: Grid | undefined,
    input: InputStrategy,
    open: Columns,
  ): void {
    this.switches(w, input, open);
    this.file.textContent = w === undefined ? "no file open" : w.status();
    // A narrow window cuts the line short, and the whole of it is a hover away.
    this.file.title = this.file.textContent;
    // A strategy that names the editor, as vim's INSERT, names transform with it
    // open, so the name wears transform's amber.
    const editing = grid?.editing() === true ? input.editing : undefined;
    this.mode.textContent = editing ?? w?.mode.toUpperCase() ?? "";
    this.mode.className = w?.mode === "transform" ? "mode t" : "mode";

    // A tab with no file behind it has no cells to be on, and " · row 1" with
    // no column in front of it would say it had.
    if (w === undefined || grid === undefined || w.active.missing) {
      this.cell.textContent = "";
      return;
    }
    const { row, col } = grid.selection();
    const header = w.rows.columns[col]?.header ?? "";
    this.cell.textContent = `${header} · ${m.status_row({ row: num(row + 1) })}`;
  }

  /** switches draws the mode switch as the workspace has it, and each column's
   * switch as open or closed. */
  private switches(w: Workspace | undefined, input: InputStrategy, open: Columns): void {
    // With nothing open there is no mode to switch.
    this.seg.hidden = w === undefined;
    this.seg.title = input.switchHint;
    for (const option of this.seg.querySelectorAll<HTMLElement>("[data-mode]")) {
      const mode = option.dataset["mode"];
      option.className = w?.mode !== mode ? "" : mode === "view" ? "on" : "on t";
    }

    this.side.classList.toggle("on", open.sidebar);
    this.side.title = open.sidebar ? m.sidebar_close_hint() : m.sidebar_open_hint();
    this.side.setAttribute("aria-label", "Sidebar");
    this.side.setAttribute("aria-pressed", String(open.sidebar));

    this.sources.classList.toggle("on", open.panel);
    this.sources.title = open.panel
      ? "Close the sources panel"
      : "Sources: what is open, and where files come from · Ctrl+Shift+B";
    this.sources.setAttribute("aria-label", "Sources");
    this.sources.setAttribute("aria-pressed", String(open.panel));
  }

  /** One line, and the only place the shell talks. */
  say(text: string, isError: boolean): void {
    this.msg.textContent = text;
    this.msg.title = text;
    this.msg.className = isError ? "err" : "";
  }

  /** keys shows what is waiting for the rest of a command, where vim's showcmd would. */
  keys(text: string): void {
    this.waiting.textContent = text;
  }

  prompt(lead: Lead): void {
    this.lead = lead;
    this.bar.classList.add("prompting");
    this.cmd.hidden = false;
    this.cmd.value = lead;
    this.cmd.focus();
  }

  close(): void {
    // Hidden first: handing the focus back blurs the input, which closes it again.
    if (this.cmd.hidden) return;
    this.cmd.hidden = true;
    this.bar.classList.remove("prompting");
    this.closed();
  }
}
