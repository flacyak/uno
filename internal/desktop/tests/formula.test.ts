// @vitest-environment happy-dom
//
// The formula form: what it opens on, and how Esc and Tab behave in it.

import { expect, test } from "vite-plus/test";

import { m } from "../src/paraglide/messages.js";
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

test("a blank header is offered by its place, as the grid names it", () => {
  document.body.innerHTML = `<div id="app" tabindex="0"></div>`;
  new FormulaForm({ left: 0, top: 0 }, "q3.csv", [{ header: "" }, { header: "qty" }], 0, {
    insert: () => Promise.resolve(),
    closed: () => undefined,
  });
  const options = [...document.querySelectorAll<HTMLOptionElement>(".formula option")];
  expect(options.map((o) => o.textContent)).toEqual([m.column_unnamed({ number: 1 }), "qty"]);
});

// The form is at the end of the page, so Tab wraps within it.
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

// Insert is disabled while an insert is in flight. Tab skips a disabled
// control, as a browser would.
test("Tab steps over a control that is disabled", () => {
  const { box } = form();
  const controls = [...box.querySelectorAll<HTMLElement>("select, input, button")];
  controls[1]!.setAttribute("disabled", "");
  controls[0]!.focus();
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(controls[2]);
  box.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(controls[0]);
});
