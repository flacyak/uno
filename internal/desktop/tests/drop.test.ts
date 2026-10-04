// @vitest-environment happy-dom
//
// Dropping a file on the window: what lights the empty state, and what a
// drop opens or refuses.

import { expect, test } from "vite-plus/test";

import { wireDrop } from "../src/renderer/shell/drop.ts";

/** A drag event with a dataTransfer whose `types` name what is dragged. */
function drag(
  type: string,
  types: readonly string[],
  files: File[] = [],
  relatedTarget: Element | null = null,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types, files } });
  Object.defineProperty(e, "relatedTarget", { value: relatedTarget });
  return e;
}

function wired(): {
  root: HTMLElement;
  zone: HTMLElement;
  child: HTMLElement;
  opened: string[][];
  refused: string[];
} {
  document.body.innerHTML = `<div id="app"><div id="empty"><h1>Drop a file</h1></div></div>`;
  const root = document.querySelector<HTMLElement>("#app")!;
  const zone = document.querySelector<HTMLElement>("#empty")!;
  const child = document.querySelector<HTMLElement>("h1")!;
  const opened: string[][] = [];
  const refused: string[] = [];
  wireDrop(
    root,
    zone,
    (files) => opened.push(files.map((f) => f.name)),
    (text) => refused.push(text),
  );
  return { root, zone, child, opened, refused };
}

test("a file over the window lights the empty state, and the drop is allowed", () => {
  const { root, zone } = wired();
  const over = drag("dragover", ["Files"]);
  root.dispatchEvent(over);
  expect(over.defaultPrevented).toBe(true);
  expect(zone.classList.contains("over")).toBe(true);
});

test("dragged text is not a file, and lights nothing", () => {
  const { root, zone } = wired();
  root.dispatchEvent(drag("dragover", ["text/plain"]));
  expect(zone.classList.contains("over")).toBe(false);
});

test("moving the file from the window onto the heading keeps the light on", () => {
  const { root, zone, child } = wired();
  root.dispatchEvent(drag("dragover", ["Files"]));
  // dragleave from the root to its own child.
  child.dispatchEvent(drag("dragleave", ["Files"], [], child));
  root.dispatchEvent(drag("dragleave", ["Files"], [], child));
  expect(zone.classList.contains("over")).toBe(true);

  // dragleave with a null relatedTarget is leaving the window.
  root.dispatchEvent(drag("dragleave", ["Files"], [], null));
  expect(zone.classList.contains("over")).toBe(false);
});

test("a drop opens the files, and one uno cannot open is refused by name", () => {
  const { root, zone, opened, refused } = wired();
  root.dispatchEvent(drag("dragover", ["Files"]));
  root.dispatchEvent(drag("drop", ["Files"], [new File([""], "q3.csv"), new File([""], "q4.tsv")]));
  expect(zone.classList.contains("over")).toBe(false);
  expect(opened).toEqual([["q3.csv", "q4.tsv"]]);

  root.dispatchEvent(
    drag("drop", ["Files"], [new File([""], "q3.csv"), new File([""], "deck.pdf")]),
  );
  expect(opened).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toContain("deck.pdf");
});
