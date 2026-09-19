// The tab strip: a tab for each source in the workspace, the dot that says one
// has unsaved work, a way to add another, and the switch between view and
// transform.

import "./tabs.css";

import type { Tab, Workspace } from "../workspace.ts";

/** What the strip's controls do. The shell decides; the strip only asks. */
export interface TabActions {
  toggle(): void;
  select(tab: Tab): void;
  remove(tab: Tab): void;
  add(): void;
}

/** tabStrip is what the strip holds for a workspace. `hint` is the switch's tooltip. */
export function tabStrip(w: Workspace, hint: string, act: TabActions): HTMLElement[] {
  // The last source stays, so it has no × to offer.
  const removable = w.sources.length > 1;
  const tabs = w.sources.map((t) => tabFor(w, t, removable, act));

  const add = document.createElement("span");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "Add a source · Ctrl+Shift+O";
  add.addEventListener("click", () => act.add());

  const grow = document.createElement("span");
  grow.className = "grow";

  const seg = document.createElement("span");
  seg.className = "seg";
  seg.title = hint;
  for (const [mode, label] of [
    ["view", "View"],
    ["transform", "Transform"],
  ] as const) {
    const option = document.createElement("span");
    option.textContent = label;
    if (w.mode === mode) option.className = mode === "view" ? "on" : "on t";
    else option.addEventListener("click", () => act.toggle());
    seg.append(option);
  }

  return [...tabs, add, grow, seg];
}

function tabFor(w: Workspace, t: Tab, removable: boolean, act: TabActions): HTMLElement {
  const tab = document.createElement("span");
  tab.className = t === w.active ? "tab active" : "tab";
  tab.dataset["source"] = t.id;
  tab.append(document.createTextNode(t.name));
  tab.addEventListener("click", () => act.select(t));

  // The dot is the only thing in the window that says there is unsaved work.
  if (w.unsaved(t)) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    dot.title = "unsaved edits";
    tab.append(dot);
  }

  if (removable) {
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = `Remove ${t.name} from the workspace`;
    close.addEventListener("click", (e) => {
      e.stopPropagation(); // removing is not selecting
      act.remove(t);
    });
    tab.append(close);
  }
  return tab;
}
