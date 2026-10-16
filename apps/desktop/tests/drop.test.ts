/**
 * @fileoverview Dropping a file on the window: what lights the empty state, and
 * what a drop opens or refuses.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import type { Listings } from "@renderer/sources";
import { Sources } from "@renderer/sources";
import { wireDrop } from "@renderer/shell/drop";

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

/** Listings for a panel that is never browsed. */
const UNLISTED: Listings = {
  list: () => Promise.reject(new Error("not listed")),
  peek: () => Promise.reject(new Error("not peeked")),
};

test("a drop opens the names the sources panel picks, and refuses the ones it lists only", () => {
  const panel = new Sources(UNLISTED, () => []);
  const names = [
    "q3.csv",
    "Q3.TSV",
    "q3.tsv.gz",
    "logs.tar.gz",
    "part-0.snappy.parquet",
    ".csv",
    "README",
    "deck.pdf",
  ];
  for (const name of names) {
    const { root, opened } = wired();
    root.dispatchEvent(drag("drop", ["Files"], [new File([""], name)]));
    const picked = panel.selectable({ name, path: `/home/jo/exports/${name}`, folder: false });
    expect(opened.length === 1, name).toBe(picked);
  }
});

test("a drop opens a workspace, which the panel does not pick", () => {
  const { root, opened } = wired();
  root.dispatchEvent(drag("drop", ["Files"], [new File([""], "Q3.UNO")]));
  expect(opened).toEqual([["Q3.UNO"]]);
});
