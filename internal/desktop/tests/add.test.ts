// @vitest-environment happy-dom
//
// What the + menu offers, and what choosing each asks the shell to do. An
// object in S3 is not typed here any more: it is browsed to or pasted in the
// sources panel, which is what Browse sources… opens.

import { expect, test } from "vite-plus/test";

import { AddMenu } from "../src/renderer/shell/add.ts";

function menu(): { asked: string[]; items: () => HTMLElement[] } {
  document.body.innerHTML = `<span class="tab-add"></span>`;
  const asked: string[] = [];
  new AddMenu(document.querySelector<HTMLElement>(".tab-add")!, {
    file: () => asked.push("file"),
    browse: () => asked.push("browse"),
    closed: () => asked.push("closed"),
  });
  return { asked, items: () => [...document.querySelectorAll<HTMLElement>(".add-item")] };
}

test("the + offers a file or the sources panel, each with its keys", () => {
  const { items } = menu();
  expect(items().map((i) => [i.firstChild?.textContent, i.lastChild?.textContent])).toEqual([
    ["File…", "Ctrl+Shift+O"],
    ["Browse sources…", "Ctrl+Shift+B"],
  ]);
});

test("Browse sources… closes the menu and asks for the panel", () => {
  const { asked, items } = menu();
  items()[1]!.click();
  expect(asked).toEqual(["closed", "browse"]);
  expect(document.querySelector(".add-menu")).toBeNull();
});
