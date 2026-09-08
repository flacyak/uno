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
 * wireDrop opens a file dropped anywhere on `root`, lighting `zone` while one is
 * over it. A file uno cannot open is refused by name.
 */
export function wireDrop(
  root: HTMLElement,
  zone: HTMLElement,
  open: (file: File) => void,
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

    const file = e.dataTransfer?.files[0];
    if (file === undefined) return;

    const name = file.name;
    if (!OPENABLE.some((ext) => name.toLowerCase().endsWith(ext))) {
      refuse(`${name} is not a spreadsheet uno can open`);
      return;
    }
    open(file);
  });
}
