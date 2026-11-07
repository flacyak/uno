/**
 * @fileoverview The chart form in real layout: Insert chart… on the open
 * workspace opens it on the selected column, and it wears the formula form's
 * look in light and in dark, its controls in line with the formula form's.
 * Escape closes it with nothing inserted, so the chart layer still waits for
 * the first workspace with charts.
 */

import { DEFAULT_THEME } from "@renderer/theme";
import type { Check } from "./check.ts";
import { RIGHT_CLICK } from "./sidebar.ts";

/** Helpers: a form opened from the workspace's menu, and what it looks like. */
const FORMS = `
  ${RIGHT_CLICK}
  const open = async (label, selector) => {
    rightClick(document.querySelector(".ws.open"));
    await frame();
    choose(label);
    return (await arrives(() => document.querySelector(selector) !== null)) ? document.querySelector(selector) : null;
  };
  const escape = (form) => form?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const style = (at, names) => names.map((name) => name + " " + getComputedStyle(at).getPropertyValue(name));
  const look = (form) => {
    const box = form.getBoundingClientRect();
    // How far in from the box's sides a part stands, and how tall it is.
    const gaps = (at, sides) => {
      const r = at.getBoundingClientRect();
      const all = { left: r.left - box.left, top: r.top - box.top, right: box.right - r.right, bottom: box.bottom - r.bottom, height: r.height };
      return sides.map((side) => side + " " + all[side].toFixed(2));
    };
    const [title, control, note] = [".title", "select", ".note"].map((at) => form.querySelector(at));
    const inks = ["color", "background-color", "border", "border-radius", "font"];
    return {
      box: [box.width, ...style(form, [...inks, "box-shadow", "padding"])],
      title: [...gaps(title, ["left", "top", "right", "height"]), ...style(title, [...inks, "border-bottom", "letter-spacing", "padding"])],
      control: [...gaps(control, ["left", "top", "right", "height"]), ...style(control, inks)],
      note: [...gaps(note, ["left", "right"]), ...style(note, ["color", "font"])],
      // The buttons stand at the foot, which is lower in the longer form.
      buttons: [...form.querySelectorAll(".buttons button")].map((at) => [...gaps(at, ["right", "bottom", "height"]), ...style(at, inks)]),
    };
  };
`;

/** One check a mode: the formula form's look, then the chart form's, left open for the shot. */
const WORN: Check[] = (["light", "dark"] as const).map((mode) => ({
  name: `in ${mode}, Insert chart… opens on the selected column in the formula form's look`,
  shot: `chart-form-${mode}`,
  script: `
    ${FORMS}
    escape(document.querySelector(".chart-form"));
    const gear = document.querySelector("#settings");
    const menu = document.querySelector(".settings");
    gear.click();
    // The run's appearance, its pressed segment, and theme, its chosen item, for the last check to choose again.
    window.smokeWorn ??= [...menu.querySelectorAll("[data-appearance].on, [data-theme].chosen")].map(({ dataset: { appearance, theme } }) => appearance === undefined ? '[data-theme="' + theme + '"]' : '[data-appearance="' + appearance + '"]');
    menu.querySelector('[data-appearance="${mode}"]').click();
    menu.querySelector('[data-theme="${DEFAULT_THEME}"]').click();
    gear.click();
    await frame();
    const formula = await open("Insert formula…", ".formula");
    if (formula === null) return "no formula form opened";
    const want = look(formula);
    escape(formula);
    const form = await open("Insert chart…", ".chart-form");
    if (form === null) return "no chart form opened";
    const by = form.querySelector('select[name="by"]');
    const selected = text("#status-cell").split(" · ")[0];
    if (by.selectedOptions[0].textContent !== selected) return "the form opened on " + by.selectedOptions[0].textContent + ", not " + selected;
    if (document.activeElement !== by) return "the keys are not in By";
    const got = look(form);
    const off = Object.keys(want).filter((part) => JSON.stringify(got[part]) !== JSON.stringify(want[part]));
    return off.map((part) => part + " is " + JSON.stringify(got[part]) + ", not " + JSON.stringify(want[part])).join(" · ");
  `,
}));

export const CHART_FORM: Check[] = [
  ...WORN,
  {
    name: "Esc closes the chart form with nothing inserted, and the chart layer still waits",
    script: `
      ${FORMS}
      escape(document.querySelector(".chart-form"));
      await frame();
      if (document.querySelector(".chart-form") !== null) return "the form stayed open";
      const gear = document.querySelector("#settings");
      gear.click();
      for (const chosen of window.smokeWorn) document.querySelector(".settings " + chosen).click();
      gear.click();
      await frame();
      if (document.querySelector(".chart") !== null) return "a chart was inserted";
      return document.querySelector("#charts").hidden ? "" : "the layer shows";
    `,
  },
];
