// File drop handling. The whole window is the drop target. The empty state
// element is highlighted while files are dragged over the window.

import "./empty.css";

import { m } from "../../paraglide/messages.js";

/** The file extensions a drop may open. */
const OPENABLE = [".uno", ".csv", ".tsv"];

/** Returns whether a drag carries files. */
function carriesFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * wireDrop opens files dropped anywhere on `root`, and adds the "over" class
 * to `zone` while files are dragged over it. The drop opens when every
 * file's extension is in OPENABLE; otherwise it is refused by the first
 * other file's name.
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
    // Prevent the default, or the page would navigate to a dropped link or
    // file.
    stop(e);
    zone.classList.toggle("over", carriesFiles(e));
  });
  root.addEventListener("dragleave", (e) => {
    stop(e);
    // A move between elements inside root keeps the highlight.
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
