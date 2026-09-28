// What the + at the end of the tab strip offers: a file off this machine, or
// the sources panel, where a bucket is browsed or an object's address pasted.
//
// It hangs off the page rather than the strip, because the strip is drawn again
// on every edit and would take an open menu down with it.

import "./add.css";

/** What choosing an item does. The shell decides; the menu only asks. */
export interface AddActions {
  /** Ask for files on this machine, as Ctrl+Shift+O does. */
  file(): void;
  /** Open the sources panel, as Ctrl+Shift+B does. */
  browse(): void;
  /** The menu closed, so the keys go back to the grid. */
  closed(): void;
}

export class AddMenu {
  private readonly box = document.createElement("div");
  private readonly away = (e: MouseEvent): void => {
    if (!this.box.contains(e.target as Node)) this.close();
  };

  constructor(
    /** The + it opened from, so it can hang beneath it. */
    anchor: HTMLElement,
    private readonly act: AddActions,
  ) {
    this.box.className = "add-menu";
    const at = anchor.getBoundingClientRect();
    this.box.style.left = `${Math.round(at.left)}px`;
    this.box.style.top = `${Math.round(at.bottom)}px`;
    this.box.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });

    this.box.append(
      this.item("File…", "Ctrl+Shift+O", () => {
        this.close();
        this.act.file();
      }),
      this.item("Browse sources…", "Ctrl+Shift+B", () => {
        this.close();
        this.act.browse();
      }),
    );
    document.body.append(this.box);
    // After this click has finished, or it would close the menu it opened.
    setTimeout(() => document.addEventListener("mousedown", this.away), 0);
  }

  close(): void {
    if (!this.box.isConnected) return;
    document.removeEventListener("mousedown", this.away);
    this.box.remove();
    this.act.closed();
  }

  private item(label: string, keys: string, choose: () => void): HTMLElement {
    const item = document.createElement("div");
    item.className = "add-item";
    const k = document.createElement("span");
    k.className = "keys";
    k.textContent = keys;
    item.append(label, k);
    item.addEventListener("click", choose);
    return item;
  }
}
