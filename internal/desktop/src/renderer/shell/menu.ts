// A small menu that hangs off the page: what the + beside a workspace's
// sources offers, and what a right click on a workspace in the sidebar does.
//
// It hangs off the page rather than the sidebar, because the sidebar is drawn
// again on every edit and would take an open menu down with it.

import "./menu.css";

import { clickAway, el, hang } from "./util.ts";

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
  private readonly box = el("div", "pop-menu");
  private disarm: () => void = () => {};

  constructor(
    place: MenuPlace,
    items: readonly MenuItem[],
    /** The menu closed, so the keys go back to the grid. */
    private readonly closed: () => void,
  ) {
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

    hang(this.box, place, EDGE);
    this.disarm = clickAway(this.box, () => this.close());
  }

  close(): void {
    if (!this.box.isConnected) return;
    this.disarm();
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
