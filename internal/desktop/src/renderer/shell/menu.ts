// A pop-up menu appended to document.body: the + menu beside a workspace's
// sources, and the right-click menu on a workspace in the sidebar.
//
// It is appended to the body because the sidebar is redrawn on every edit
// and would remove an open menu.

import "./menu.css";

import { clickAway, el, hang } from "./util.ts";

/** One menu item: its label, the shortcut shown beside it, and what it does. */
export interface MenuItem {
  label: string;
  keys?: string;
  choose: () => void;
}

/** Where a menu opens: its top-left corner, in window coordinates. */
export interface MenuPlace {
  left: number;
  top: number;
}

/** The minimum gap between a menu and the window's edge, in pixels. */
const EDGE = 4;

/** below returns the place directly under an element, left edges aligned. */
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
    /** Called when the menu closes. */
    private readonly closed: () => void,
  ) {
    this.box.setAttribute("role", "menu");
    this.box.addEventListener("keydown", (e) => {
      // Keep the key from reaching the grid and the shell's shortcuts.
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    // A right click on the menu leaves it as it is.
    this.box.addEventListener("contextmenu", (e) => e.preventDefault());

    this.box.append(...items.map((item) => this.item(item)));
    document.body.append(this.box);
    // Focus the menu so Esc closes it.
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
