// Page, over a plain DOM: happy-dom's document, driven directly.
//
// electron-page.ts answers every question by shipping a string across
// `webContents.executeJavaScript` to a document in another process. There is no
// such boundary here -- this backend and the page it reads share one realm --
// so there is nothing to serialise. Each method below does in plain TypeScript
// exactly what the matching string in electron-page.ts does in the renderer:
// same selectors, same DOM reads, same key-dispatch shape. Keeping the two
// side by side is what makes a difference between them worth noticing.
//
// What this file cannot do anything about is layout: happy-dom parses and
// mutates a tree but never lays it out, so `clientHeight`, `offsetHeight` and
// `getBoundingClientRect()` are all zero unless something fakes them first. See
// dom-harness.ts.

import type { KeyModifiers, Page, Row, Wait } from "../../src/main/smoke/page.ts";

/** Matches electron-page.ts's own budget: see its TRIES for why. */
const TRIES = 150;

/** A frame, the way the grid schedules its own layout: two rAFs, so a write
 * made in one is visible by the time the second's callback runs. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** A `Wait`, as a predicate over the live document -- the direct-call twin of
 * electron-page.ts's `condition`, which builds the same check as a string. */
function holds(wait: Wait): boolean {
  const at =
    "selector" in wait
      ? (document.querySelector(wait.selector)?.textContent ?? "")
      : (document.querySelectorAll("tbody tr")[wait.row]?.children[wait.col + 1]?.textContent ??
        "");
  return "equals" in wait ? at === wait.equals : at.includes(wait.includes);
}

export function domPage(): Page {
  return {
    bridgeExposed: async () =>
      typeof (window as unknown as { uno?: { open?: unknown } }).uno?.open === "function",

    text: async (selector) => document.querySelector(selector)?.textContent ?? "",

    allText: async (selector) =>
      [...document.querySelectorAll(selector)].map((e) => e.textContent ?? ""),

    ownText: async (selector) =>
      [...document.querySelectorAll(selector)].map((e) => e.firstChild?.textContent ?? ""),

    count: async (selector) => document.querySelectorAll(selector).length,

    hasClass: async (selector, className, index = 0) =>
      document.querySelectorAll(selector)[index]?.classList.contains(className) ?? false,

    hidden: async (selector) =>
      Boolean((document.querySelector(selector) as HTMLElement | null)?.hidden),

    rows: async () =>
      [...document.querySelectorAll("tbody tr")].map((tr): Row => ({
        gutter: tr.children[0]?.textContent ?? "",
        className: tr.className,
        cells: [...tr.children].slice(1).map((td) => td.textContent ?? ""),
      })),

    clickCell: async (row, col) => {
      (
        document.querySelectorAll("tbody tr")[row]?.children[col + 1] as HTMLElement | undefined
      )?.click();
    },

    click: async (selector) => (document.querySelector(selector) as HTMLElement | null)?.click(),

    editorValue: async () =>
      (document.querySelector(".cell-editor") as HTMLInputElement | null)?.value,

    setEditorValue: async (value) => {
      const editor = document.querySelector(".cell-editor") as HTMLInputElement | null;
      if (editor !== null) editor.value = value;
    },

    // A key goes where a real one would: to the editor while it is open, to the
    // grid otherwise. Matches electron-page.ts's own press.
    press: async (key, modifiers: KeyModifiers = {}) => {
      const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
      target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }));
      await frame();
    },

    settle: async (frames) => {
      for (let i = 0; i < frames; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },

    // The whole poll runs in one call, same as electron-page.ts's until: a
    // check waiting on a frame-by-frame condition must not pay one await per
    // frame outside this backend either.
    until: async (waits) => {
      const ok = (): boolean => waits.every(holds);
      for (let i = 0; i < TRIES && !ok(); i++) await frame();
      return ok();
    },

    scrollTo: async (top) => {
      const scroller = document.querySelector(".grid-scroll") as HTMLElement | null;
      if (scroller !== null) scroller.scrollTop = top;
    },
  };
}
