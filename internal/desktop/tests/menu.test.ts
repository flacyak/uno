// @vitest-environment happy-dom
//
// The menu hung off the page: what it offers, that choosing closes it first,
// and that it gets out of the way the ways a menu should.

import { expect, test } from "vite-plus/test";

import { PopMenu, below } from "../src/renderer/shell/menu.ts";

function menu(): { asked: string[]; items: () => HTMLElement[]; made: PopMenu } {
  document.body.innerHTML = `<span class="tab-add"></span>`;
  const asked: string[] = [];
  const made = new PopMenu(
    below(document.querySelector<HTMLElement>(".tab-add")!),
    [
      { label: "File…", keys: "Ctrl+Shift+O", choose: () => asked.push("file") },
      { label: "Browse sources…", keys: "Ctrl+Shift+B", choose: () => asked.push("browse") },
      { label: "Insert formula…", choose: () => asked.push("formula") },
    ],
    () => asked.push("closed"),
  );
  return { asked, items: () => [...document.querySelectorAll<HTMLElement>(".pop-item")], made };
}

test("each item says what it does, and the keys that do the same", () => {
  const { items } = menu();
  expect(items().map((i) => [i.firstChild?.textContent, i.lastChild?.textContent])).toEqual([
    ["File…", "Ctrl+Shift+O"],
    ["Browse sources…", "Ctrl+Shift+B"],
    ["Insert formula…", ""],
  ]);
});

test("choosing an item closes the menu, then does what it says", () => {
  const { asked, items } = menu();
  items()[1]!.click();
  expect(asked).toEqual(["closed", "browse"]);
  expect(document.querySelector(".pop-menu")).toBeNull();
});

test("Esc closes the menu and chooses nothing", () => {
  const { asked } = menu();
  document
    .querySelector(".pop-menu")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(asked).toEqual(["closed"]);
  expect(document.querySelector(".pop-menu")).toBeNull();
});

test("closing twice says so once", () => {
  const { asked, made } = menu();
  made.close();
  made.close();
  expect(asked).toEqual(["closed"]);
});
