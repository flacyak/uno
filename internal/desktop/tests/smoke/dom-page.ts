// Page over a plain DOM: happy-dom's document, driven directly.
//
// electron-page.ts sends each question as a string across
// `webContents.executeJavaScript`. Here the backend and the page share one
// realm, so each method does in TypeScript what the matching string in
// electron-page.ts does: same selectors, same DOM reads, same key dispatch.
//
// happy-dom skips layout, so `clientHeight`, `offsetHeight` and
// `getBoundingClientRect()` are zero until faked. See dom-harness.ts.

import type { KeyModifiers, Page, Row, Wait } from "../../src/main/smoke/page.ts";

/**
 * The longest a wait lasts. electron-page.ts counts 150 frames. happy-dom's
 * frame is one turn of the event loop and is over at once, so the wait here
 * is bounded by the clock, and polls once a frame.
 */
const WAIT_MS = 5_000;

/** Two rAFs, which is how the grid schedules its layout, so a write made in
 * one is visible in the second's callback. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** A `Wait` as a predicate over the live document, the twin of
 * electron-page.ts's `condition`. */
function holds(wait: Wait): boolean {
  const at =
    "selector" in wait
      ? (document.querySelector(wait.selector)?.textContent ?? "")
      : (document.querySelectorAll("tbody tr")[wait.row]?.children[wait.col + 1]?.textContent ??
        "");
  return "equals" in wait ? at === wait.equals : at.includes(wait.includes);
}

/** Waits a frame at a time, for WAIT_MS at most, for `holds` to be true. */
export async function until(page: Page, holds: () => boolean): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (!holds() && Date.now() < deadline) await page.settle(2);
  return holds();
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

    // A key goes to the editor while it is open, and to the grid otherwise.
    // Matches electron-page.ts's press.
    press: async (key, modifiers: KeyModifiers = {}) => {
      const target = document.querySelector(".cell-editor") ?? document.querySelector("#content");
      // Cancelable, as a browser's keydown is, so a later listener sees when
      // an earlier one took the key.
      target?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
      );
      await frame();
    },

    settle: async (frames) => {
      for (let i = 0; i < frames; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },

    // The whole poll runs in one call, as electron-page.ts's until does.
    until: async (waits) => {
      const ok = (): boolean => waits.every(holds);
      const deadline = Date.now() + WAIT_MS;
      while (!ok() && Date.now() < deadline) await frame();
      return ok();
    },

    scrollTo: async (top) => {
      const scroller = document.querySelector(".grid-scroll") as HTMLElement | null;
      if (scroller !== null) scroller.scrollTop = top;
    },
  };
}
