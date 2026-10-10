// @vitest-environment happy-dom
//
// The words in the page's markup: index.html ships the elements empty, and
// labelPage writes them in the app's language.
//
// Checks that every element gets its words, and that writing them again
// keeps the elements that have handlers wired to them.

import { beforeEach, expect, test } from "vite-plus/test";

import { m } from "../src/paraglide/messages.js";
import { baseLocale } from "../src/paraglide/runtime.js";
import { labelPage } from "../src/renderer/shell/page.ts";
import { bodyMarkup } from "./markup.ts";

beforeEach(() => {
  document.body.innerHTML = bodyMarkup();
});

const text = (selector: string): string => document.querySelector(selector)?.textContent ?? "";

test("the markup ships its elements without their words", () => {
  // The dot, the + and the extensions are the same in every language, so they
  // are all the text the markup holds.
  expect(document.body.textContent.replace(/\s+/g, " ").trim()).toBe("+ csv · tsv · uno ·");
});

test("labelPage writes the heads, the empty state and the switch", () => {
  labelPage();
  expect(text(".sidebar-head")).toBe(m.workspaces_title());
  expect(text("#new .label")).toBe(m.new_workspace());
  expect(text("#empty h1")).toBe(m.empty_title());
  expect(text('[data-mode="view"]')).toBe(m.switch_view());
  expect(text('[data-mode="transform"]')).toBe(m.switch_transform());
});

test("the empty state's sentence keeps its link, with the words the message marks", () => {
  const open = document.querySelector("#open")!;
  labelPage();
  expect(text("#empty p")).toBe("or open one");
  expect(open.textContent).toBe("open one");
  // The same element, since the click that opens a file is wired to it.
  expect(document.querySelector("#open")).toBe(open);

  labelPage();
  expect(text("#empty p")).toBe("or open one");
  expect(document.querySelector("#open")).toBe(open);
});

test("the controls with no words on them are named aloud", () => {
  labelPage();
  expect(document.querySelector("#status-cmd")?.getAttribute("aria-label")).toBe(m.command_aria());
  expect(document.querySelector("#close")?.getAttribute("aria-label")).toBe(m.close_window_aria());
});

test("the page says which language it is in, and which way it reads", () => {
  labelPage();
  expect(document.documentElement.lang).toBe(baseLocale);
  expect(document.documentElement.dir).toBe("ltr");
});
