// Dropping a file is the fastest way in, and the one the design leads with.
//
// The whole window is the target rather than a rectangle inside it: a person
// dropping a spreadsheet on a window means to open it, and making them find the
// panel is a rule the app made up. The empty state is what lights up.

import "./empty.css";

import { m } from "../../paraglide/messages.js";

/** The extensions the app will try to open. Anything else is very likely a
 * mis-drop, and saying so is better than a parser error. */
const OPENABLE = [".uno", ".csv", ".tsv"];

/** Whether a drag carries files, rather than text or a link out of the page. */
function carriesFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * wireDrop opens the files dropped anywhere on `root`, lighting `zone` while
 * some are over it. Several can come at once, because a workspace is built from
 * several exports. A file uno cannot open is refused by name, and the drop with
 * it.
 */
export function wireDrop(
  root: HTMLElement,
  zone: HTMLElement,
  open: (files: File[]) => void,
  refuse: (text: string) => void,
): void {
  const stop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  root.addEventListener("dragover", (e) => {
    // Stopped whatever is dragged: a link or a file the page did not take
    // would otherwise be navigated to, and the app left behind.
    stop(e);
    zone.classList.toggle("over", carriesFiles(e));
  });
  root.addEventListener("dragleave", (e) => {
    stop(e);
    // Leaving one element of the window for another is not leaving the
    // window, and the light would blink off and on across every edge.
    if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
    zone.classList.remove("over");
  });
  root.addEventListener("drop", (e) => {
    stop(e);
    zone.classList.remove("over");

    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;

    const odd = files.find((f) => !OPENABLE.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (odd !== undefined) {
      refuse(m.drop_not_spreadsheet({ name: odd.name }));
      return;
    }
    open(files);
  });
}
