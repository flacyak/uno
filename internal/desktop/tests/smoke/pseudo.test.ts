// @vitest-environment happy-dom
//
// The real shell, over the real engine, in the pseudo-locale: every word on
// screen has to have come through a message.
//
// A pseudo-message is accented and sits in brackets. So after the language is
// changed to it, any plain letters left in the window are a sentence somebody
// wrote into the code, or one that was written once and not written again when
// the language changed. Either would be English in every language.
//
// What a file holds is not the app's to translate, and neither is a name that
// is the same in every language. Those are named below, each with why.

import { beforeAll, expect, test } from "vite-plus/test";

import { PSEUDO_CLOSE, PSEUDO_LOCALE, PSEUDO_OPEN } from "../../scripts/pseudo.js";
import { m } from "../../src/paraglide/messages.js";
import type { Shell } from "../../src/renderer/shell/shell.ts";
import { bootShell } from "./dom-harness.ts";

/**
 * Where what is drawn is not the app's to translate: the file's own cells and
 * its columns' names, and a language's name for itself, on the settings item
 * that says it is in that language with a `lang` of its own.
 */
const NOT_THE_APPS = [
  "tbody",
  ".colhead",
  ".panel-peek table",
  ".formula select",
  "[data-language][lang]",
];

/**
 * Where one message is written across several elements, so it is read as the
 * one sentence it is: the empty state's line, with its link in the middle.
 */
const ONE_SENTENCE = ["#empty p"];

/** The attributes a person reads or hears, beside the text itself. */
const SPOKEN = ["title", "aria-label", "placeholder"];

/**
 * What is the same in every language, as a pattern over what is left of a
 * text once its messages are taken out.
 */
const UNTRANSLATED: readonly RegExp[] = [
  // The fixture's own name, as a tab, a workspace and a path.
  /\S*sales-q3\S*/g,
  // A column's kind and the formula badge, which are names the engine goes by.
  /\b(date|text|num|fx)\b/g,
  // Keys and chords, as they are printed on a keyboard.
  /\b(?:Ctrl|Shift|Esc)(?:\+(?:Shift|[A-Z]))*\b/g,
  // The themes, which are their authors' names for them, and the product's.
  /Paper Ember|Tokyo Night|Sakura|Catppuccin Frappé|T3 Themes|uno\b/g,
  // The example bucket, a provider and a profile, which are AWS's names.
  /acme-exports|\bs3\b|\bdefault\b|~\/\.aws/g,
  // The example role's ARN, which is AWS's shape for one.
  /arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+/g,
  // The file extensions the empty state lists.
  /\b(csv|tsv)\b/g,
  // The encoding a file was read in, by the name everyone calls it.
  /UTF-8/g,
];

/** A message, innermost first, so one that holds another is taken out whole. */
const MESSAGE = new RegExp(`${PSEUDO_OPEN}[^${PSEUDO_OPEN}${PSEUDO_CLOSE}]*${PSEUDO_CLOSE}`, "g");

/** plain is what is left of a text that is neither a message nor a name: its English. */
function plain(text: string): string {
  let rest = text;
  for (let was = ""; was !== rest;) {
    was = rest;
    rest = rest.replace(MESSAGE, "");
  }
  for (const name of UNTRANSLATED) rest = rest.replace(name, "");
  return /\p{L}/u.test(rest) ? rest.trim() : "";
}

/** english is every text and spoken attribute in the window with plain letters in it. */
function english(): string[] {
  const found: string[] = [];
  const sentences = ONE_SENTENCE.join(",");
  for (const el of document.documentElement.querySelectorAll<HTMLElement>("body, body *")) {
    if (el.closest(NOT_THE_APPS.join(",")) !== null) continue;
    const tag = `<${el.tagName.toLowerCase()} class="${el.className}">`;
    // A sentence across several elements is read once, where it starts.
    const texts = el.matches(sentences)
      ? [el.textContent]
      : el.closest(sentences) !== null
        ? []
        : [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent);
    for (const text of texts) {
      const left = plain(text ?? "");
      if (left !== "") found.push(`${tag} ${left}`);
    }
    for (const name of SPOKEN) {
      const left = plain(el.getAttribute(name) ?? "");
      if (left !== "") found.push(`${name} of ${tag} ${left}`);
    }
  }
  return found;
}

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const click = (selector: string): void => {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`nothing matches ${selector}`);
  el.click();
};

let shell: Shell;

beforeAll(async () => {
  shell = await bootShell();
  // Everything that can be on screen at once, opened in English first, so
  // what is checked is that changing the language writes each of them again.
  click("#panel-toggle");
  click("#settings");
  await frame();
  shell.language.choose(PSEUDO_LOCALE);
  await frame();
}, 20_000);

test("the window is in the language chosen", () => {
  expect(document.documentElement.lang).toBe(PSEUDO_LOCALE);
  expect(document.querySelector(".sidebar-head")?.textContent).toBe(m.workspaces_title());
  expect(m.workspaces_title().startsWith(PSEUDO_OPEN)).toBe(true);
});

test("an open file, the sidebar, the sources panel and settings say nothing in plain English", () => {
  expect(document.querySelector(".settings")?.hasAttribute("hidden")).toBe(false);
  expect(document.querySelector("#panel")?.hasAttribute("hidden")).toBe(false);
  expect(english()).toEqual([]);
});

test("transform, and what a locked key says in view, are in the language chosen", async () => {
  click("#settings");
  click('#mode-switch [data-mode="transform"]');
  await frame();
  expect(document.querySelector("#status-mode")?.textContent).toBe(m.mode_transform());
  expect(english()).toEqual([]);
});

test("the form that connects a bucket is in the language chosen", async () => {
  const connect = [...document.querySelectorAll<HTMLElement>("#panel .panel-row.action")][0];
  connect?.click();
  await frame();
  expect(document.querySelector(".panel-connect")?.hasAttribute("hidden")).toBe(false);
  expect(english()).toEqual([]);
});

test("a right click on the workspace offers its menu in the language chosen", async () => {
  const row = document.querySelector<HTMLElement>("#workspaces .ws");
  row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await frame();
  expect(document.querySelectorAll(".pop-item").length).toBeGreaterThan(0);
  expect(english()).toEqual([]);
});
