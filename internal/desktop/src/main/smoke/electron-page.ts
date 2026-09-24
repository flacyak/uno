// Page, over a real Electron window.
//
// This is the only file allowed to hold renderer JavaScript as a string. Each
// string here answers one kind of question -- read this text, click this
// cell, wait for these conditions -- for every check that asks it, rather than
// one check having a script of its own. That is what keeps `Page` honest: a
// check that wants something this file cannot express needs a new method on
// the interface, not a new string here.

import type { BrowserWindow } from "electron";

import type { KeyModifiers, Page, Row, Wait } from "./page.ts";

/** The wait budget a poll gets: this many frames, each a real animation frame
 * apart. Matches the budget the string-based checks already poll with -- see
 * index.ts's PRELUDE. */
const TRIES = 150;

function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression) as Promise<T>;
}

/** A `Wait`, as the boolean expression that tests it in the renderer. */
function condition(wait: Wait): string {
  const at =
    "selector" in wait
      ? `(document.querySelector(${JSON.stringify(wait.selector)})?.textContent ?? "")`
      : `(document.querySelectorAll("tbody tr")[${wait.row}]?.children[${wait.col + 1}]?.textContent ?? "")`;
  return "equals" in wait
    ? `${at} === ${JSON.stringify(wait.equals)}`
    : `${at}.includes(${JSON.stringify(wait.includes)})`;
}

export function electronPage(win: BrowserWindow): Page {
  return {
    bridgeExposed: () => evaluate<boolean>(win, `typeof window.uno?.open === "function"`),

    text: (selector) =>
      evaluate<string>(
        win,
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`,
      ),

    allText: (selector) =>
      evaluate<string[]>(
        win,
        `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent ?? "")`,
      ),

    ownText: (selector) =>
      evaluate<string[]>(
        win,
        `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.firstChild?.textContent ?? "")`,
      ),

    count: (selector) =>
      evaluate<number>(win, `document.querySelectorAll(${JSON.stringify(selector)}).length`),

    hasClass: (selector, className, index = 0) =>
      evaluate<boolean>(
        win,
        `(document.querySelectorAll(${JSON.stringify(selector)})[${index}]?.classList.contains(${JSON.stringify(className)}) ?? false)`,
      ),

    hidden: (selector) =>
      evaluate<boolean>(
        win,
        `document.querySelector(${JSON.stringify(selector)})?.hidden ?? false`,
      ),

    rows: () =>
      evaluate<Row[]>(
        win,
        `[...document.querySelectorAll("tbody tr")].map((tr) => ({
           gutter: tr.children[0]?.textContent ?? "",
           className: tr.className,
           cells: [...tr.children].slice(1).map((td) => td.textContent ?? ""),
         }))`,
      ),

    clickCell: (row, col) =>
      evaluate<void>(
        win,
        `document.querySelectorAll("tbody tr")[${row}].children[${col + 1}].click()`,
      ),

    click: (selector) =>
      evaluate<void>(win, `document.querySelector(${JSON.stringify(selector)}).click()`),

    editorValue: () =>
      evaluate<string | undefined>(win, `document.querySelector(".cell-editor")?.value`),

    setEditorValue: (value) =>
      evaluate<void>(
        win,
        `document.querySelector(".cell-editor").value = ${JSON.stringify(value)}`,
      ),

    // A key goes where a real one would: to the editor while it is open, to
    // the grid otherwise. Matches PRELUDE's own `press`, so a check reads the
    // same whichever form it is.
    press: (key, modifiers: KeyModifiers = {}) =>
      evaluate<void>(
        win,
        `(async () => {
           const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
           target.dispatchEvent(new KeyboardEvent("keydown", {
             key: ${JSON.stringify(key)},
             bubbles: true,
             ...${JSON.stringify(modifiers)},
           }));
           await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
         })()`,
      ),

    settle: (frames) =>
      evaluate<void>(
        win,
        `(async () => {
           for (let i = 0; i < ${frames}; i++) await new Promise((r) => requestAnimationFrame(r));
         })()`,
      ),

    // The whole poll runs in one evaluate: a wait that round-tripped once per
    // frame would turn 150 frames of patience into 150 IPC calls.
    until: (waits) => {
      const ok = waits.length === 0 ? "true" : waits.map(condition).join(" && ");
      return evaluate<boolean>(
        win,
        `(async () => {
           const ok = () => ${ok};
           for (let i = 0; i < ${TRIES} && !ok(); i++) {
             await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
           }
           return ok();
         })()`,
      );
    },

    scrollTo: (top) =>
      evaluate<void>(win, `document.querySelector(".grid-scroll").scrollTop = ${top}`),
  };
}
