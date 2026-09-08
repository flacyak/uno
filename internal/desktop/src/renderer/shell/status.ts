// The status bar: the mode, the file, the one line the shell talks on, keys
// waiting for more, and where the selection is.
//
// It also holds the prompt: a command after :, a search after / or ?. While the
// prompt is open it stands in for the file's line.

import "./status.css";

import type { Grid } from "../grid/index.ts";
import type { InputStrategy } from "../input/index.ts";
import type { Lead } from "../keys.ts";
import type { Workspace } from "../workspace.ts";
import { must } from "./util.ts";

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

  /**
   * Enter runs what was typed and Esc closes the prompt, as do clicking away and
   * deleting the character it opened with.
   */
  constructor(
    /** Enter in the prompt: what it began with, and what was typed after that. */
    private readonly entered: (lead: Lead, typed: string) => void,
    /** The prompt closed, so the keys go back to the grid. */
    private readonly closed: () => void,
  ) {
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

  /** paint says what is open, which mode it is in, and where the selection is. */
  paint(w: Workspace | undefined, grid: Grid | undefined, input: InputStrategy): void {
    this.file.textContent = w === undefined ? "no file open" : w.status();
    // A strategy that names the editor, as vim's INSERT, names transform with it
    // open, so the name wears transform's amber.
    const editing = grid?.editing() === true ? input.editing : undefined;
    this.mode.textContent = editing ?? w?.mode.toUpperCase() ?? "";
    this.mode.className = w?.mode === "transform" ? "mode t" : "mode";

    if (w === undefined || grid === undefined) {
      this.cell.textContent = "";
      return;
    }
    const { row, col } = grid.selection();
    const header = w.rows.columns[col]?.header ?? "";
    this.cell.textContent = `${header} · row ${row + 1}`;
  }

  /** One line, and the only place the shell talks. */
  say(text: string, isError: boolean): void {
    this.msg.textContent = text;
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
