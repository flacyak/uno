/**
 * @fileoverview The chart form in real layout: Insert chart… on the open
 * workspace opens it on the selected column, and it wears the formula form's
 * look in light and in dark, its controls in line with the formula form's.
 * Escape closes it with nothing inserted, so the chart layer still waits for
 * the first workspace with charts. Each note a schedule shows fits its two
 * lines in every language. Ctrl+Shift+G and the View menu open it under the
 * selected column's header, which comes back first if it was scrolled out of
 * a zoomed window.
 */

import { m } from "@paraglide/messages";
import { offered } from "@renderer/language";
import { DEFAULT_THEME } from "@renderer/theme";
import { pressing } from "./chart-moves.ts";
import { DOUBLE_ZOOM, NARROW_WIDTH } from "./charts.ts";
import type { Check } from "./check.ts";
import { RIGHT_CLICK } from "./sidebar.ts";

/** The fixture's name, for the notes that name the source. */
const NAMED = { name: "sales-q3.csv" };

/** In each language a person can choose, the chart form's labels in the order
 * of its fields, which set the note's width, and each note a schedule shows. */
const SAID = offered(false).map((locale) => ({
  labels: [
    m.chart_form_source,
    m.chart_form_kind,
    m.chart_form_by,
    m.chart_form_sum,
    m.chart_form_x,
    m.chart_form_y,
    m.chart_form_title_field,
    m.chart_form_refresh,
  ].map((label) => label({}, { locale })),
  notes: [
    m.chart_refresh_does_file,
    m.chart_refresh_does_object,
    m.chart_refresh_does_folder,
    m.chart_refresh_note_carried,
    m.chart_refresh_note_lost,
  ].map((note) => note(NAMED, { locale })),
}));

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

/** The chart form opened by its keys on the selected column, closed once
 * measured, and `under`, the header cell's rules its border lies on. */
const KEYED = `
  if (!(await arrives(() => document.querySelector(".chart-form") !== null))) return "no chart form opened";
  const form = document.querySelector(".chart-form");
  const by = form.querySelector('select[name="by"]');
  const cell = document.querySelector("thead tr").children[Number(by.value) + GUTTER];
  const [box, head, chosen] = [form.getBoundingClientRect(), cell.getBoundingClientRect(), by.selectedOptions[0].textContent];
  form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (chosen !== text("#status-cell").split(" · ")[0]) return "the form opened on " + chosen;
  const rule = (at, side) => parseFloat(getComputedStyle(at).getPropertyValue("border-" + side + "-width"));
  const under = [head.left - rule(cell.previousElementSibling, "right"), head.bottom - rule(cell, "bottom")].map(Math.round);
`;

/** The chart form opened by its keys stands under the selected column's header. */
const UNDER_HEAD = `
  ${KEYED}
  const at = [box.left, box.top].map(Math.round);
  return at.join() === under.join() ? "" : "the form stands at " + at + ", not under the header at " + under;
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
  {
    name: "every note the chart form says of a schedule fits its two lines, in every language",
    script: `
      ${FORMS}
      const form = await open("Insert chart…", ".chart-form");
      if (form === null) return "no chart form opened";
      const [labels, note] = [[...form.querySelectorAll(".field .what")], form.querySelector(".note")];
      const cut = [];
      for (const said of ${JSON.stringify(SAID)}) {
        said.labels.forEach((label, i) => (labels[i].textContent = label));
        for (const text of said.notes) {
          note.textContent = text;
          if (note.scrollHeight > note.clientHeight) cut.push(text);
        }
      }
      escape(form);
      return cut.length === 0 ? "" : "cut: " + cut.join(" · ");
    `,
  },
  {
    name: "Ctrl+Shift+G opens the chart form under the selected column's header",
    input: { events: pressing("G", ["control", "shift"]), through: true },
    script: UNDER_HEAD,
  },
  {
    name: "the View menu's Insert chart… opens the chart form under the selected column's header",
    pick: "CmdOrCtrl+Shift+G",
    script: UNDER_HEAD,
  },
  {
    name: "at 200% zoom, region's column scrolls out of view with region selected",
    window: { zoom: DOUBLE_ZOOM },
    script: `
      if (!(await until(() => innerWidth < ${NARROW_WIDTH}))) return "the page is " + innerWidth + "px wide";
      document.querySelectorAll("tbody tr")[2].children[GUTTER + REGION].click();
      const sheet = document.querySelector(".grid-scroll");
      sheet.scrollLeft = sheet.scrollWidth;
      await frame();
      const head = document.querySelector("thead tr").children[GUTTER + REGION].getBoundingClientRect();
      return head.right <= sheet.getBoundingClientRect().left ? "" : "region's header stands at " + head.right;
    `,
  },
  {
    name: "Ctrl+Shift+G scrolls the selected column back and opens the chart form over it",
    input: { events: pressing("G", ["control", "shift"]), through: true },
    script: `
      ${KEYED}
      const sheet = document.querySelector(".grid-scroll").getBoundingClientRect();
      if (head.left < sheet.left || head.right > sheet.right) return "the header stands at " + head.left + " to " + head.right;
      // The zoomed page leaves the form too little room to stand at the header's left.
      const over = box.left < head.right && head.left < box.right;
      return over && Math.round(box.top) === under[1] ? "" : "the form stands at " + box.left + "," + box.top + ", away from " + under;
    `,
  },
  {
    name: "back at full zoom, the page is as wide as the run began",
    window: {},
    script: `return (await until(() => innerWidth > ${NARROW_WIDTH})) ? "" : "the page is " + innerWidth + "px wide";`,
  },
];
