// The status bar: the mode, the file line, the message line, pending keys,
// and the selected cell. It also holds the prompt for : commands and / and ?
// searches, which replaces the file line while open.
//
// The switches at its ends: the sidebar toggle on the left; the mode switch
// and the sources panel toggle on the right.

import "./status.css";

import { m } from "../../paraglide/messages.js";
import type { Grid } from "../grid/index.ts";
import { columnLabel } from "../grid/rows.ts";
import type { InputStrategy } from "../input/index.ts";
import type { Lead } from "../keys.ts";
import { num } from "../locale.ts";
import type { Mode, Workspace } from "../workspace.ts";
import { must } from "./util.ts";

/** What the bar's switches ask of the shell. */
export interface StatusAsks {
  /** Switch between view and transform. */
  toggleMode(): void;
  /** Open or close the sidebar. */
  toggleSidebar(): void;
  /** Open or close the sources panel. */
  togglePanel(): void;
}

/** Which of the window's side columns are open. */
export interface Columns {
  sidebar: boolean;
  panel: boolean;
}

/** The word the bar shows for a mode. */
function modeWord(mode: Mode): string {
  return mode === "view" ? m.mode_view() : m.mode_transform();
}

export class StatusBar {
  /** The character the open prompt began with. */
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
   * Enter runs the prompt. Esc closes it, as do blur and deleting the lead
   * character.
   */
  constructor(
    /**
     * Called on Enter in the prompt with the lead and the text typed after it.
     */
    private readonly entered: (lead: Lead, typed: string) => void,
    /** Called when the prompt closes. */
    private readonly closed: () => void,
    asks: StatusAsks,
  ) {
    for (const option of this.seg.querySelectorAll<HTMLElement>("[data-mode]")) {
      // A click switches the mode when it lands on the option that is off.
      option.addEventListener("click", () => {
        if (!option.classList.contains("on")) asks.toggleMode();
      });
    }
    this.side.addEventListener("click", () => asks.toggleSidebar());
    this.sources.addEventListener("click", () => asks.togglePanel());

    const input = this.cmd;
    input.addEventListener("keydown", (e) => {
      // Keep the key from reaching the grid and the shell's shortcuts.
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
   * paint draws the file line, the mode, the selected cell, and the switches.
   */
  paint(
    w: Workspace | undefined,
    grid: Grid | undefined,
    input: InputStrategy,
    open: Columns,
  ): void {
    this.switches(w, input, open);
    this.file.textContent = w === undefined ? m.no_file_open() : w.status();
    // The full text is the hover text, for a narrow window.
    this.file.title = this.file.textContent;
    // While the cell editor is open, the input strategy's editor name (such as
    // INSERT) replaces the mode word.
    const editing = grid?.editing() === true ? input.editing : undefined;
    this.mode.textContent = editing ?? (w === undefined ? "" : modeWord(w.mode));
    this.mode.className = w?.mode === "transform" ? "mode t" : "mode";

    // The cell line is empty until there is a grid and the tab has a file.
    if (w === undefined || grid === undefined || w.active.missing) {
      this.cell.textContent = "";
      return;
    }
    const { row, col } = grid.selection();
    const column = w.rows.columns[col];
    const header = column === undefined ? "" : columnLabel(column.header, col);
    // An empty sheet shows the column only.
    this.cell.textContent =
      w.rows.rows() === 0 ? header : `${header} · ${m.status_row({ row: num(row + 1) })}`;
  }

  /** switches draws the mode switch and the two column toggles. */
  private switches(w: Workspace | undefined, input: InputStrategy, open: Columns): void {
    // The mode switch shows while a workspace is open.
    this.seg.hidden = w === undefined;
    this.seg.title = input.switchHint;
    for (const option of this.seg.querySelectorAll<HTMLElement>("[data-mode]")) {
      const mode = option.dataset["mode"];
      option.className = w?.mode !== mode ? "" : mode === "view" ? "on" : "on t";
    }

    this.side.classList.toggle("on", open.sidebar);
    this.side.title = open.sidebar ? m.sidebar_close_hint() : m.sidebar_open_hint();
    this.side.setAttribute("aria-label", m.sidebar_aria());
    this.side.setAttribute("aria-pressed", String(open.sidebar));

    this.sources.classList.toggle("on", open.panel);
    this.sources.title = open.panel ? m.panel_close_hint() : m.panel_open_hint();
    this.sources.setAttribute("aria-label", m.sources_title());
    this.sources.setAttribute("aria-pressed", String(open.panel));
  }

  /** say writes the message line. */
  say(text: string, isError: boolean): void {
    this.msg.textContent = text;
    this.msg.title = text;
    this.msg.className = isError ? "err" : "";
  }

  /** keys shows a partly typed command, like vim's showcmd. */
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
    // Hide the input first: giving focus back blurs it, which calls close
    // again.
    if (this.cmd.hidden) return;
    this.cmd.hidden = true;
    this.bar.classList.remove("prompting");
    this.closed();
  }
}
