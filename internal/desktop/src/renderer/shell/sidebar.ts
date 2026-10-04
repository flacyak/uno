// The sidebar: the workspaces opened on this machine, most recent first. The
// open one lists its sources under it, one tab each, with a dot for unsaved
// work and a + to add another.

import "./arriving.css";
import "./sidebar.css";

import { m } from "../../paraglide/messages.js";
import { opening } from "../sources.ts";
import type { Arriving } from "../sources.ts";
import type { Tab, Workspace } from "../workspace.ts";
import type { MenuPlace } from "./menu.ts";
import { baseName, el, folderName } from "./util.ts";

/** The extension stripped from a workspace's name. */
const UNO = /\.uno$/i;

/** What the sidebar's controls ask of the shell. */
export interface SidebarActions {
  /** Open a workspace from the list in place of the open one. */
  open(path: string): void;
  /**
   * A workspace was right-clicked: open its menu at `place`. `path` is "" for
   * an open workspace that is still unsaved.
   */
  menu(path: string, place: MenuPlace): void;
  select(tab: Tab): void;
  remove(tab: Tab): void;
  /** The + under the sources was clicked: open the add menu under `plus`. */
  add(plus: HTMLElement): void;
  /**
   * Open the panel to pick a file for a tab whose file is missing or changed.
   */
  repoint(tab: Tab): void;
}

/** workspaceName is a workspace's file name, with the .uno extension off. */
export function workspaceName(path: string): string {
  return baseName(path).replace(UNO, "");
}

/**
 * sidebarRows builds the list's rows: the open workspace, its sources, the
 * sources in `arriving` that are still opening, the + row, then every other
 * path in `recents`. For an empty list it returns one note row.
 */
export function sidebarRows(
  w: Workspace | undefined,
  recents: readonly string[],
  act: SidebarActions,
  arriving: readonly Arriving[] = [],
): HTMLElement[] {
  const rows: HTMLElement[] = [];
  if (w !== undefined) {
    rows.push(openRow(w, act));
    // A workspace keeps its last source, so the × shows from two sources up.
    const removable = w.sources.length > 1;
    rows.push(...w.sources.map((t) => tabFor(w, t, removable, act)));
    rows.push(...arriving.map(arrivingRow));

    const add = el("div", "tab-add", m.sidebar_add_source());
    add.title = m.sidebar_add_source_hint();
    add.setAttribute("role", "button");
    add.addEventListener("click", () => act.add(add));
    rows.push(add);
  }
  for (const path of recents) {
    if (path !== w?.path) rows.push(recentRow(path, act));
  }
  if (rows.length === 0) rows.push(el("div", "note", m.no_workspaces()));
  return rows;
}

/**
 * The row for a source that is still opening: its name, dimmed, with a
 * progress bar.
 */
function arrivingRow(a: Arriving): HTMLElement {
  const row = el("div", "tab-opening");
  row.title = `${a.name} · ${opening()}`;
  row.setAttribute("aria-busy", "true");
  row.append(el("span", "name", a.name));
  return row;
}

/**
 * The row for the open workspace, with a dirty dot when it has unsaved changes.
 */
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
  if (w.dirty) row.append(dirty(m.unsaved_changes()));
  return row;
}

function recentRow(path: string, act: SidebarActions): HTMLElement {
  const row = workspaceRow(workspaceName(path), folderName(path), path, path, act);
  row.addEventListener("click", () => act.open(path));
  return row;
}

/**
 * One workspace's row: its name and the folder it is in, with `title` as the
 * hover text.
 */
function workspaceRow(
  name: string,
  meta: string,
  title: string,
  path: string,
  act: SidebarActions,
): HTMLElement {
  const row = el("div", "ws");
  row.dataset["path"] = path;
  row.title = title;
  row.setAttribute("role", "button");
  row.append(el("span", "name", name), el("span", "meta", meta));

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    act.menu(path, { left: e.clientX, top: e.clientY });
  });
  return row;
}

function tabFor(w: Workspace, t: Tab, removable: boolean, act: SidebarActions): HTMLElement {
  const tab = el("div", t === w.active ? "tab active" : "tab");
  tab.dataset["source"] = t.id;
  // The name is in its own span, so a long name is cut short and the marks
  // beside it keep their width. The full name is the hover text.
  tab.title = t.name;
  tab.append(el("span", "name", t.name));
  tab.addEventListener("click", () => act.select(t));

  // A ! mark for a tab whose file is missing, changed under the log, or has a
  // newer version in its bucket. Clicking the mark opens the panel on the
  // tab. Clicking the tab itself still selects it.
  const trouble = t.trouble;
  if (trouble !== undefined || t.newer !== undefined) {
    const mark = el("span", t.missing ? "trouble gone" : "trouble", "!");
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

  // The dot marks unsaved work.
  if (w.unsaved(t)) tab.append(dirty(m.unsaved_edits()));

  if (removable) {
    const close = el("span", "close", "×");
    close.title = m.sidebar_remove_source({ name: t.name });
    close.addEventListener("click", (e) => {
      e.stopPropagation(); // keep the click on the ×
      act.remove(t);
    });
    tab.append(close);
  }
  return tab;
}

/** The dot that marks unsaved work, with `hint` as its hover text. */
function dirty(hint: string): HTMLElement {
  const dot = el("span", "dirty");
  dot.title = hint;
  return dot;
}
