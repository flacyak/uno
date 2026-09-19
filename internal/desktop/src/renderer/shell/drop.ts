// Dropping a file is the fastest way in, and the one the design leads with.
//
// The whole window is the target rather than a rectangle inside it: a person
// dropping a spreadsheet on a window means to open it, and making them find the
// panel is a rule the app made up. The empty state is what lights up.

import "./empty.css";

/** The extensions the app will try to open. Anything else is very likely a
 * mis-drop, and saying so is better than a parser error. */
const OPENABLE = [".uno", ".csv", ".tsv"];

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
    stop(e);
    zone.classList.add("over");
  });
  root.addEventListener("dragleave", (e) => {
    stop(e);
    zone.classList.remove("over");
  });
  root.addEventListener("drop", (e) => {
    stop(e);
    zone.classList.remove("over");

    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;

    const odd = files.find((f) => !OPENABLE.some((ext) => f.name.toLowerCase().endsWith(ext)));
    if (odd !== undefined) {
      refuse(`${odd.name} is not a spreadsheet uno can open`);
      return;
    }
    open(files);
  });
}
