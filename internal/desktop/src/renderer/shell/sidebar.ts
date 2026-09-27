// The sidebar: the workspaces opened on this machine, most recent first. The
// one that is open lists its sources under it, a tab each, with the dot that
// says one has unsaved work and a way to add another.

import "./sidebar.css";

import { m } from "../../paraglide/messages.js";
import type { Tab, Workspace } from "../workspace.ts";
import type { MenuPlace } from "./menu.ts";
import { baseName, folderName } from "./util.ts";

/** The extension a workspace's name is shown without. */
const UNO = /\.uno$/i;

/** What the sidebar's controls do. The shell decides; the sidebar only asks. */
export interface SidebarActions {
  /** Open a workspace from the list, in place of the one open now. */
  open(path: string): void;
  /**
   * A workspace was right-clicked: offer what can be done with it, at `place`.
   * `path` is "" for the open workspace while it has never been saved.
   */
  menu(path: string, place: MenuPlace): void;
  select(tab: Tab): void;
  remove(tab: Tab): void;
  /** The + under the sources was clicked: offer a file or the sources panel,
   * hung off `plus`. */
  add(plus: HTMLElement): void;
  /** Point a source at a file, from the sources panel: one whose file has
   * gone, or one that changed under the log. */
  repoint(tab: Tab): void;
}

/** workspaceName is what a workspace is called in the list: its file, without the extension. */
export function workspaceName(path: string): string {
  return baseName(path).replace(UNO, "");
}

/**
 * sidebarRows is what the list holds: the open workspace with its sources,
 * then every other one in `recents`, which is most recent first.
 */
export function sidebarRows(
  w: Workspace | undefined,
  recents: readonly string[],
  act: SidebarActions,
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  if (w !== undefined) {
    rows.push(openRow(w, act));
    // The last source stays, so it has no × to offer.
    const removable = w.sources.length > 1;
    rows.push(...w.sources.map((t) => tabFor(w, t, removable, act)));

    const add = document.createElement("div");
    add.className = "tab-add";
    add.textContent = m.sidebar_add_source();
    add.title = m.sidebar_add_source_hint();
    add.setAttribute("role", "button");
    add.addEventListener("click", () => act.add(add));
    rows.push(add);
  }
  for (const path of recents) {
    if (path !== w?.path) rows.push(recentRow(path, act));
  }
  if (rows.length === 0) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = m.no_workspaces();
    rows.push(note);
  }
  return rows;
}

/** The workspace that is open: its name, and whether a save would change it. */
function openRow(w: Workspace, act: SidebarActions): HTMLElement {
  const saved = w.path !== "";
  const row = workspaceRow(
    saved ? workspaceName(w.path) : workspaceName(w.suggestedFileName),
    saved ? folderName(w.path) : m.not_saved(),
    saved ? w.path : m.sidebar_not_saved_hint(),
    w.path,
    act,
  );
  row.classList.add("open");
  if (w.dirty) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    dot.title = m.unsaved_changes();
    row.append(dot);
  }
  return row;
}

function recentRow(path: string, act: SidebarActions): HTMLElement {
  const row = workspaceRow(workspaceName(path), folderName(path), path, path, act);
  row.addEventListener("click", () => act.open(path));
  return row;
}

/**
 * One workspace's line: its name, and the folder it is in, which is what
 * tells two called q3-close apart. The whole path is a hover away.
 */
function workspaceRow(
  name: string,
  meta: string,
  title: string,
  path: string,
  act: SidebarActions,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "ws";
  row.dataset["path"] = path;
  row.title = title;
  row.setAttribute("role", "button");

  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  const beside = document.createElement("span");
  beside.className = "meta";
  beside.textContent = meta;
  row.append(label, beside);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    act.menu(path, { left: e.clientX, top: e.clientY });
  });
  return row;
}

function tabFor(w: Workspace, t: Tab, removable: boolean, act: SidebarActions): HTMLElement {
  const tab = document.createElement("div");
  tab.className = t === w.active ? "tab active" : "tab";
  tab.dataset["source"] = t.id;
  // The name in a box of its own, so a name longer than the sidebar is cut
  // short rather than the marks beside it; the whole name is a hover away.
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = t.name;
  tab.title = t.name;
  tab.append(name);
  tab.addEventListener("click", () => act.select(t));

  // A source whose file is gone, or is not the file the log was written
  // against. Clicking the mark opens the panel on it to pick where the file is
  // now; the tab itself still selects, because its edits are worth looking at either way.
  // One whose bucket holds a newer version wears the same mark, which opens
  // the panel on its line, where Reload reads the newer one.
  const trouble = t.trouble;
  if (trouble !== undefined || t.newer !== undefined) {
    const mark = document.createElement("span");
    mark.className = t.missing ? "trouble gone" : "trouble";
    mark.textContent = "!";
    mark.title =
      t.newer !== undefined && !t.missing
        ? `${m.newer_version()} · ${m.sidebar_open_line_hint()}`
        : `${trouble} · ${m.sidebar_point_hint()}`;
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      act.repoint(t);
    });
    tab.append(mark);
  }

  // The dot is what says this source has unsaved work.
  if (w.unsaved(t)) {
    const dot = document.createElement("span");
    dot.className = "dirty";
    dot.title = m.unsaved_edits();
    tab.append(dot);
  }

  if (removable) {
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.title = m.sidebar_remove_source({ name: t.name });
    close.addEventListener("click", (e) => {
      e.stopPropagation(); // removing is not selecting
      act.remove(t);
    });
    tab.append(close);
  }
  return tab;
}
