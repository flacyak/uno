// The tab strip: the open file, the dot that says it has unsaved work, and the
// switch between view and transform.

import "./tabs.css";

import type { Workspace } from "../workspace.ts";

/** tabStrip is what the strip holds for a workspace. `hint` is the switch's tooltip. */
export function tabStrip(w: Workspace, hint: string, toggle: () => void): HTMLElement[] {
  const tab = document.createElement("span");
  tab.className = "tab active";
  tab.append(document.createTextNode(w.name));
  // The dot is the only thing in the window that says there is unsaved work.
  if (w.dirty) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    dot.title = "unsaved edits";
    tab.append(dot);
  }

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
    else option.addEventListener("click", toggle);
    seg.append(option);
  }

  return [tab, grow, seg];
}
