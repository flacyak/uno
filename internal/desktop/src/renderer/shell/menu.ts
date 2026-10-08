// A small menu that hangs off the page: what the + beside a workspace's
// sources offers, and what a right click on a workspace in the sidebar does.
//
// It hangs off the page rather than the sidebar, because the sidebar is drawn
// again on every edit and would take an open menu down with it.

import "./menu.css";

import { el } from "./util.ts";

/** One thing a menu offers, and the keys that do the same. */
export interface MenuItem {
  label: string;
  keys?: string;
  choose: () => void;
}

/** Where a menu opens: its top left corner, in the window. */
export interface MenuPlace {
  left: number;
  top: number;
}

/** The least room a menu keeps between itself and the window's edge, in pixels. */
const EDGE = 4;

/** below is the place under an element, its left edge on the element's. */
export function below(anchor: HTMLElement): MenuPlace {
  const at = anchor.getBoundingClientRect();
  return { left: Math.round(at.left), top: Math.round(at.bottom) };
}

export class PopMenu {
  private readonly box = document.createElement("div");
  private readonly away = (e: MouseEvent): void => {
    if (!this.box.contains(e.target as Node)) this.close();
  };

  constructor(
    place: MenuPlace,
    items: readonly MenuItem[],
    /** The menu closed, so the keys go back to the grid. */
    private readonly closed: () => void,
  ) {
    this.box.className = "pop-menu";
    this.box.setAttribute("role", "menu");
    this.box.addEventListener("keydown", (e) => {
      // The grid's keys and the shell's chords stay out of what is typed here.
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    // A right click on the menu is not a second menu.
    this.box.addEventListener("contextmenu", (e) => e.preventDefault());

    this.box.append(...items.map((item) => this.item(item)));
    document.body.append(this.box);
    // The keys come here, so Esc closes it whatever had them before.
    this.box.tabIndex = -1;
    this.box.focus();

    // Opened near the bottom or the right of the window, it moves in until
    // the whole of it shows.
    const { width, height } = this.box.getBoundingClientRect();
    const left = Math.min(place.left, window.innerWidth - width - EDGE);
    const top = Math.min(place.top, window.innerHeight - height - EDGE);
    this.box.style.left = `${Math.max(EDGE, left)}px`;
    this.box.style.top = `${Math.max(EDGE, top)}px`;

    // After this click has finished, or it would close the menu it opened.
    setTimeout(() => document.addEventListener("mousedown", this.away), 0);
  }

  close(): void {
    if (!this.box.isConnected) return;
    document.removeEventListener("mousedown", this.away);
    this.box.remove();
    this.closed();
  }

  private item({ label, keys, choose }: MenuItem): HTMLElement {
    const item = el("div", "pop-item");
    item.setAttribute("role", "menuitem");
    item.append(label, el("span", "keys", keys ?? ""));
    item.addEventListener("click", () => {
      this.close();
      choose();
    });
    return item;
  }
}
