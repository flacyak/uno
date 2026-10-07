// @vitest-environment happy-dom
//
// The formula form hung off the page: the keys stay in it while it is open,
// and get out of the way the ways a form should.

import { expect, test } from "vite-plus/test";

import { FormulaForm } from "../src/renderer/shell/formula.ts";

function form(): { asked: string[]; box: HTMLFormElement } {
  document.body.innerHTML = `<div id="app" tabindex="0"></div>`;
  const asked: string[] = [];
  new FormulaForm(
    { left: 0, top: 0 },
    "q3.csv",
    [{ header: "price" }, { header: "qty" }, { header: "total", binding: "price * qty" }],
    2,
    {
      insert: (col, expr) => {
        asked.push(`insert ${col} ${expr}`);
        return Promise.resolve();
      },
      closed: () => asked.push("closed"),
    },
  );
  return { asked, box: document.querySelector<HTMLFormElement>(".formula")! };
}

test("it opens on the selected column, with its expression ready to change", () => {
  const { box } = form();
  expect(box.querySelector("select")!.value).toBe("2");
  expect(box.querySelector("input")!.value).toBe("price * qty");
  expect(document.activeElement).toBe(box.querySelector("input"));
});

test("Esc closes it and inserts nothing", () => {
  const { asked, box } = form();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(asked).toEqual(["closed"]);
  expect(document.querySelector(".formula")).toBeNull();
});

// The form hangs off the end of the page, so Tab would otherwise carry the
// keys to the window's × behind it, with the form left open.
test("Tab walks the controls round the ends, and never leaves the form", () => {
  const { box } = form();
  const controls = [...box.querySelectorAll<HTMLElement>("select, input, button")];
  const tab = (shiftKey: boolean): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(e);
    return e;
  };
  expect(controls).toHaveLength(4);
  controls[0]!.focus();
  expect(tab(true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls.at(-1));
  expect(tab(false).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(controls[0]);
  expect(document.querySelector(".formula")).toBe(box);
});
