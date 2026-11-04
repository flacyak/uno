/**
 * @fileoverview Checks of the chart windows in real layout: the layer over the
 * sheet lands a window on the rules around it, clear of both scrollbars and the
 * ×, inside its room at 200% zoom, and tucked to its head where the side columns
 * leave too little room. None of it marks the workspace unsaved, and the grid
 * still takes the pointer and the keys beside a window. In light and dark, a
 * window reads as the settings menu's box, the sidebar's band and the window's ×.
 * Its bars draw once its chart's tally completes, as bars.ts sizes them, and a
 * scatter's points stand inside its axes, against labels on their gridlines.
 *
 * They open the workspace smoke.js wrote, whose two charts stand at the sheet's
 * right edge, one at the top and one at the foot. The last three open others:
 * one whose sums leave a window of the least width too little room for bars and
 * values, one of a scatter, and one of three scatters whose x axis has room for
 * its labels in full in one window, not in a second, and not even compactly in
 * the third.
 */

import { BARS_INSET, SPAN_LEAST } from "@renderer/chart/bars";
import { DEFAULT_HEIGHT, HEAD_LEAST_WIDTH } from "@renderer/chart/place";
import { POINT_OPACITY, TICK_GAP } from "@renderer/chart/scatter";
import { DEFAULT_THEME } from "@renderer/theme";
import type { Check, Input } from "./check.ts";

/** The workspace smoke.js wrote. */
const CHARTED = process.env["UNO_SMOKE_CHARTED"] ?? "";

/** The one it wrote of a sum per region, and its regions, whose values run long on both sides of zero. */
const SIGNED = process.env["UNO_SMOKE_SIGNED"] ?? "";
const SIGNED_REGIONS = 4;

/** The one it wrote of a scatter of the fixture's revenue against its units. */
const SCATTERED = process.env["UNO_SMOKE_SCATTERED"] ?? "";

/**
 * The one it wrote of two scatters along 0 to 800,000, in a new window and one
 * of the least width, and one of the least width along 900,000 to 1,050,000,
 * and how each writes its x axis.
 */
const ALONG = process.env["UNO_SMOKE_ALONG"] ?? "";
const ALONG_LABELS = [
  ["0", "200,000", "400,000", "600,000", "800,000"],
  ["0", "200K", "400K", "600K", "800K"],
  ["900,000", "1,000,000"],
];

/** The zoom that halves the room. */
const DOUBLE_ZOOM = 2;

/** The window's least width, where both side columns leave too little room. */
const NARROW_WIDTH = 640;

/**
 * The View menu's Zoom In pressed five times: Electron's factor is 1.2 to the
 * zoom level, and a press adds half a level. Each scrollbar is a fraction of a
 * CSS px here, which clientWidth rounds one way and clientHeight the other.
 */
const MENU_ZOOM = 1.2 ** 2.5;

/** A page under this has taken that zoom: the run's 1100 px window is 698 px wide then. */
const MENU_ZOOM_WIDTH = 800;

/** How far two rects can read apart, past Chromium's layout unit of 1/64 px. */
export const RECT_SLACK = 0.02;

/** A point over the grid's tenth row, left of the windows, and one over the top window. */
const BESIDE = { x: 400, y: 300 };
const OVER_WINDOW = { x: 900, y: 150 };

/** The row the selection reaches: the one clicked, then the one below it. */
const ROW_BELOW = 11;

/** A person's click on the grid, and the arrow they press after it. */
const CLICK_AND_ARROW: readonly Input[] = [
  { type: "mouseDown", ...BESIDE, button: "left", clickCount: 1 },
  { type: "mouseUp", ...BESIDE, button: "left", clickCount: 1 },
  { type: "keyDown", keyCode: "Down" },
  { type: "keyUp", keyCode: "Down" },
];

/** A point on the top window's head, in the run's 1100 px window and its 960 at scale 2. */
const OVER_HEAD = { x: 800, y: 43 };

/** A person's click on that head. */
const CLICK_HEAD: readonly Input[] = [
  { type: "mouseDown", ...OVER_HEAD, button: "left", clickCount: 1 },
  { type: "mouseUp", ...OVER_HEAD, button: "left", clickCount: 1 },
];

/** A key a person presses that the app does nothing with. */
const A_KEY: readonly Input[] = [
  { type: "keyDown", keyCode: "Shift" },
  { type: "keyUp", keyCode: "Shift" },
];

/** A sheet that leaves a room under a head's least width, past the 12 px bar. */
const THIN_SHEET = 40;

/** A sheet too short for two heads, which take 59 px under the header row. */
const SHORT_SHEET = 80;

/** How many times over a title runs past any window. */
const LONG_TITLE = 40;

/** What a finger gets around a ×, as the design asks of head buttons. */
const FINGER = "28px";

/** A caption's height, which MIN_HEIGHT allows for. */
const CAPTION = 22;

/** The second export's rows per Location, the largest first, as a new window's bars say them. */
const LOCATION_ROWS = ["661", "656", "650", "633"];

/** What a window copies from the settings menu. */
const BOX_LOOK = [
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "box-sizing",
  "color",
  "font-family",
  "font-size",
];

/** What a head copies from the sidebar's band. */
const HEAD_LOOK = [
  "background-color",
  "border-bottom",
  "color",
  "font-family",
  "font-size",
  "height",
  "letter-spacing",
  "text-transform",
  "user-select",
];

/** What a window's × copies from the window's own. */
const X_LOOK = ["background-color", "border", "border-radius", "color", "cursor", "width"];

/** Helpers: a window's parts, and a CSS colour as the page computes it. */
const CHROME = `
  const box = () => document.querySelector(".chart");
  const head = () => box().querySelector(".chart-head");
  const x = () => box().querySelector(".round-x");
  const style = (at) => getComputedStyle(at);
  const rowHeight = () => parseFloat(style(document.documentElement).getPropertyValue("--row-h"));
  const computed = (colour) => {
    const probe = document.createElement("div");
    probe.style.color = colour;
    document.body.append(probe);
    const worn = style(probe).color;
    probe.remove();
    return worn;
  };
`;

/** Helpers: the boxes of the windows and the layer, and what the checks ask of them. */
export const GEOMETRY = `
  const windows = () => [...document.querySelectorAll(".chart")].map((w) => w.getBoundingClientRect());
  const room = () => document.querySelector("#charts").getBoundingClientRect();
  const header = () => document.querySelector("thead").getBoundingClientRect();
  const border = () => parseFloat(getComputedStyle(document.querySelector("thead th")).borderBottomWidth);
  const rule = () => header().bottom - border();
  const within = (at, box) => at.left >= box.left && at.top >= box.top && at.right <= box.right && at.bottom <= box.bottom;
  const edges = (at) => [at.left, at.top, at.right, at.bottom].join(" ");
  const unsaved = () => document.querySelector(".ws.open .dirty") !== null;
  const HEAD = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h"));
  const heads = () => windows().every((at) => at.height === HEAD + border() && at.width === room().width);
`;

/** What a window, its head and its × copy, by selector. */
const COPIES = [
  { of: "the settings menu's box", copy: ".chart", from: ".settings", names: BOX_LOOK },
  { of: "the sidebar's band", copy: ".chart-head", from: "#sidebar .col-head", names: HEAD_LOOK },
  { of: "the window's ×", copy: ".chart .round-x", from: "#close", names: X_LOOK },
  {
    of: "the settings menu's divider",
    copy: ".chart-caption",
    from: ".settings section + section",
    names: ["border-top"],
  },
];

/**
 * One check per appearance, in the theme a person starts on: each part reads as
 * what it copies. The menu has to be open to be read.
 */
const WORN: Check[] = (["dark", "light"] as const).map((mode) => ({
  name: `in ${mode} a window wears the dialogs' box, the sidebar's band and the window's ×`,
  shot: `chart-${mode}`,
  script: `
    ${CHROME}
    const gear = document.querySelector("#settings");
    const menu = document.querySelector(".settings");
    gear.click();
    menu.querySelector('[data-appearance="${mode}"]').click();
    menu.querySelector('[data-theme="${DEFAULT_THEME}"]').click();
    await frame();
    const off = ${JSON.stringify(COPIES)}.flatMap(({ of, copy, from, names }) => names.flatMap((name) => {
      const [worn, want] = [copy, from].map((at) => style(document.querySelector(at)).getPropertyValue(name));
      return worn === want ? [] : [of + "'s " + name + " is " + want + ", and not " + worn];
    }));
    gear.click();
    return off.join(" · ");
  `,
}));

export const CHARTS: Check[] = [
  {
    name: "the chart layer waits hidden, its stylesheet unloaded, until a workspace has charts",
    script: `
      const layer = document.querySelector("#charts");
      if (!layer.hidden) return "the layer shows";
      const position = getComputedStyle(layer).position;
      return position === "static" ? "" : "the layer is already " + position;
    `,
  },
  {
    name: "a workspace's charts open on the header row's rule, over it, clear of both scrollbars and the ×",
    send: ["menu:open-path", CHARTED],
    shot: "charts-layer",
    script: `
      ${GEOMETRY}
      if (!(await arrives(() => windows().length === 2))) return "the windows are " + windows().length + " · " + JSON.stringify(text("#status-msg"));
      const scroller = document.querySelector(".grid-scroll");
      if (scroller.scrollWidth <= scroller.clientWidth || scroller.scrollHeight <= scroller.clientHeight) {
        return "both scrollbars should show, so this checks nothing";
      }
      const sheet = scroller.getBoundingClientRect();
      const right = sheet.left + scroller.clientWidth;
      const bottom = sheet.top + scroller.clientHeight;
      const close = document.querySelector("#close").getBoundingClientRect();
      const [top, foot] = windows();
      if (top.top !== rule()) return "the top window starts at " + top.top + ", and the header row's rule at " + rule();
      const edge = document.elementFromPoint((top.left + top.right) / 2, top.top);
      if (edge.closest(".chart") === null) return "the top window's border is under the " + edge.tagName;
      if (top.right !== right) return "the top window ends at " + top.right + ", and the scrollbar starts at " + right;
      if (foot.right !== right) return "the foot window ends at " + foot.right + ", and the scrollbar starts at " + right;
      if (foot.bottom !== bottom) return "the foot window ends at " + foot.bottom + ", and the scrollbar starts at " + bottom;
      if (top.top < close.bottom) return "the top window starts at " + top.top + ", beside the × to " + close.bottom;
      return unsaved() ? "opening the workspace marked it unsaved" : "";
    `,
  },
  {
    name: "a chart draws its bars once its tally completes, in the accent, as thick and as far apart as bars.ts sets, each value on its label's line",
    shot: "chart-bars",
    script: `
      ${GEOMETRY}
      ${CHROME}
      const plots = [...document.querySelectorAll(".chart-plot")];
      const all = (plot, selector) => [...plot.querySelectorAll(selector)];
      const said = (plot) => all(plot, ".chart-bar-tip").map((tip) => tip.textContent).join();
      const want = ${JSON.stringify(LOCATION_ROWS.join())};
      if (!(await arrives(() => plots.every((plot) => said(plot) === want)))) return "the bars say " + plots.map(said).join(" and ");
      const [plot] = plots;
      const px = (name) => parseFloat(style(plot.querySelector(".chart-bars")).getPropertyValue(name));
      const [thick, gap, inset] = ["--bar-thick", "--bar-gap", "--bars-inset"].map(px);
      const [bars, tips, labels] = [".chart-bar", ".chart-bar-tip", ".chart-bar-label"].map((at) => all(plot, at).map((one) => one.getBoundingClientRect()));
      const track = plot.querySelector(".chart-bar-track").getBoundingClientRect();
      if (bars[0].top !== plot.getBoundingClientRect().top + inset) return "the first bar stands at " + edges(bars[0]);
      for (const [i, bar] of bars.entries()) {
        const above = i === 0 ? bar.top - gap : bars[i - 1].bottom;
        if (bar.height !== thick || bar.top - above !== gap || bar.left !== track.left) return "bar " + i + " stands at " + edges(bar);
        if (labels[i].right > bar.left || tips[i].left < bar.right) return "bar " + i + " at " + edges(bar) + " meets its label or its value";
      }
      if (Math.abs(tips[0].right - track.right) > ${RECT_SLACK}) return "the longest value ends at " + tips[0].right + ", and its track at " + track.right;
      const top = (at) => { const range = document.createRange(); range.selectNodeContents(at); return range.getBoundingClientRect().top; };
      const [values, names] = [".chart-bar-tip", ".chart-bar-label"].map((at) => all(plot, at).map(top));
      const off = values.findIndex((value, i) => value !== names[i]);
      if (off !== -1) return "value " + off + "'s text stands at " + values[off] + ", and its label's at " + names[off];
      const worn = [style(plot.querySelector(".chart-bar")).backgroundColor, style(plot.querySelector(".chart-bar-tip")).color];
      const inks = [computed("var(--accent)"), computed("var(--ink-2)")];
      return worn.join() === inks.join() ? "" : "a bar and its value wear " + worn.join(" and ");
    `,
  },
  {
    // An offer takes three fixes by hand, so this shows the banner itself: the
    // layer answers to the grid's box, however that moves.
    name: "a banner pushes the layer down, and the layer comes back up with it",
    script: `
      ${GEOMETRY}
      const banner = document.querySelector("#banner");
      const bare = room().top;
      banner.textContent = "remove commas";
      banner.hidden = false;
      const under = await until(() => room().top > bare && room().top === rule());
      banner.hidden = true;
      if (!under) return "the layer starts at " + room().top + ", and the header row's rule at " + rule();
      return (await until(() => room().top === bare)) ? "" : "the layer stayed at " + room().top;
    `,
  },
  {
    // A scrollbar-color drops uno's own bars for the browser's wider ones, as
    // Firefox draws them. The layer measures them when the banner moves it.
    name: "the layer stays clear of the wider scrollbars a browser draws for itself",
    script: `
      ${GEOMETRY}
      const scroller = document.querySelector(".grid-scroll");
      const banner = document.querySelector("#banner");
      const gauge = document.querySelector(".chart-gauge");
      const bar = () => scroller.offsetWidth - scroller.clientWidth;
      const meet = (edge, want) => Math.abs(edge - want) < ${RECT_SLACK};
      const clear = () => {
        const sheet = scroller.getBoundingClientRect();
        const inside = gauge.getBoundingClientRect();
        return meet(room().right, sheet.left + inside.width) && meet(room().bottom, sheet.top + inside.height);
      };
      const ours = bar();
      scroller.style.scrollbarColor = "gray transparent";
      banner.hidden = false;
      const wider = await until(() => bar() > ours && clear());
      const stood = edges(room());
      scroller.style.scrollbarColor = "";
      banner.hidden = true;
      if (!wider) return "the layer stands at " + stood + " beside bars of " + bar() + "px";
      return (await until(() => bar() === ours && clear())) ? "" : "the layer stayed at " + edges(room());
    `,
  },
  {
    name: "the grid takes a click and its keys beside a window, and a window takes the pointer over itself",
    input: { events: CLICK_AND_ARROW, through: true },
    script: `
      const cell = () => text("#status-cell");
      if (!(await until(() => cell().endsWith("row ${ROW_BELOW}")))) return "the selection is at " + cell();
      const at = (point) => document.elementFromPoint(point.x, point.y);
      const beside = at(${JSON.stringify(BESIDE)});
      if (beside.closest("#content") === null) return "beside the windows is " + beside.tagName;
      const over = at(${JSON.stringify(OVER_WINDOW)});
      return over.closest(".chart") === null ? "over the window is " + over.tagName : "";
    `,
  },
  {
    // A window's last device px stands over the grid, and the next on the bar.
    name: "at the View menu's 158%, a window meets both scrollbars with no grid past it",
    window: { zoom: MENU_ZOOM },
    script: `
      ${GEOMETRY}
      const middle = (px) => (px + 0.5) / devicePixelRatio;
      const grid = (x, y) => document.elementsFromPoint(x, y).some((hit) => hit.matches("td, th"));
      const meets = () => {
        const [top, foot] = windows();
        const right = Math.round(top.right * devicePixelRatio);
        const bottom = Math.round(foot.bottom * devicePixelRatio);
        const y = (top.top + top.bottom) / 2;
        const x = (foot.left + foot.right) / 2;
        return grid(middle(right - 1), y) && !grid(middle(right), y) && grid(x, middle(bottom - 1)) && !grid(x, middle(bottom));
      };
      if (await until(() => innerWidth < ${MENU_ZOOM_WIDTH} && meets())) return "";
      return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
    `,
  },
  {
    name: "at 200% zoom the windows stay inside the room",
    window: { zoom: DOUBLE_ZOOM },
    shot: "charts-zoomed",
    script: `
      ${GEOMETRY}
      if (!(await until(() => innerWidth < ${NARROW_WIDTH}))) return "the page is " + innerWidth + "px wide";
      await frame();
      if (room().top !== rule()) return "the layer starts at " + room().top + ", and the header row's rule at " + rule();
      for (const at of windows()) {
        if (!within(at, room())) return "a window stands at " + edges(at) + " in a room at " + edges(room());
        if (at.height === HEAD + border()) return "a window is tucked in a room at " + edges(room());
      }
      return unsaved() ? "the zoom marked the workspace unsaved" : "";
    `,
  },
  {
    // Tucked here, the windows are what the next check's reshape lands on, so
    // that check has to tell them from the ones it waits for.
    name: "at 200% zoom with both side columns open, each window tucks to its head",
    script: `
      ${GEOMETRY}
      await openPanel();
      return (await until(heads)) ? "" : "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
    `,
  },
  {
    name: "in a narrow window with both side columns open, each window tucks to its head",
    window: { width: NARROW_WIDTH },
    shot: "charts-tucked",
    script: `
      ${GEOMETRY}
      // The zoomed page is narrower, and its windows are tucked as well.
      const tucked = () => innerWidth >= ${NARROW_WIDTH} && heads();
      if (!(await until(tucked))) return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
      const [top, foot] = windows();
      const sidebar = document.querySelector("#sidebar").getBoundingClientRect();
      if (top.left !== sidebar.right - border()) return "the top window stands at " + edges(top) + " beside a sidebar to " + sidebar.right;
      if (top.top !== room().top || foot.top !== top.bottom - border()) return "the heads stand at " + edges(top) + " and " + edges(foot);
      return unsaved() ? "tucking marked the workspace unsaved" : "";
    `,
  },
  {
    name: "tucked heads read as one stack: square where they meet, behind one shadow that falls on neither",
    script: `
      ${GEOMETRY}
      const [upper, lower] = [...document.querySelectorAll(".chart")].map((at) => [at, getComputedStyle(at)]);
      const stack = getComputedStyle(document.querySelector("#charts"), "::before");
      const shared = [upper[1].borderBottomLeftRadius, upper[1].borderBottomRightRadius, lower[1].borderTopLeftRadius, lower[1].borderTopRightRadius];
      if (shared.some((radius) => radius !== "0px")) return "the heads meet on corners of " + shared.join(", ");
      const outer = [upper[1].borderTopLeftRadius, lower[1].borderBottomRightRadius, stack.borderTopLeftRadius];
      if (new Set(outer).size > 1) return "the stack's outer corners differ: " + outer.join(", ");
      if (upper[1].boxShadow !== "none" || lower[1].boxShadow !== "none") return "the heads throw " + upper[1].boxShadow + " and " + lower[1].boxShadow;
      const [top, foot] = windows();
      if (parseFloat(stack.height) !== foot.bottom - top.top) return "the shadow is " + stack.height + " high, behind heads at " + edges(top) + " and " + edges(foot);
      const menu = getComputedStyle(document.querySelector(".settings")).boxShadow;
      if (stack.boxShadow !== menu) return "the stack throws " + stack.boxShadow + ", and the settings menu " + menu;
      upper[0].scrollTop = 1;
      return upper[0].scrollTop === 0 ? "" : "a tucked window scrolls past its head";
    `,
  },
  {
    name: "with room again, each window goes back to its place",
    window: {},
    script: `
      ${GEOMETRY}
      document.querySelector("#panel-toggle").click();
      const back = () => {
        const [top, foot] = windows();
        return top.height === ${DEFAULT_HEIGHT} && top.top === room().top && top.right === room().right && foot.bottom === room().bottom;
      };
      if (!(await until(back))) return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
      return unsaved() ? "going back marked the workspace unsaved" : "";
    `,
  },
  {
    name: "with the sidebar closed, the layer starts at the window's own edge",
    script: `
      ${GEOMETRY}
      const toggle = document.querySelector("#sidebar-toggle");
      toggle.click();
      const flush = await until(() => room().left === 0);
      toggle.click();
      return flush ? "" : "the layer starts at " + room().left;
    `,
  },
  ...WORN,
  {
    name: "a head is one row high and drags nothing, its × centred as the window's own, and the caption ends the box",
    script: `
      ${CHROME}
      const [band, cross] = [head(), x()].map((at) => at.getBoundingClientRect());
      if (band.height !== rowHeight()) return "the head is " + band.height + "px high";
      if (style(head()).getPropertyValue("-webkit-app-region") !== "no-drag") return "the head would drag the app's window";
      const rule = parseFloat(style(head()).borderBottomWidth);
      const gaps = [cross.top - band.top, band.bottom - rule - cross.bottom, band.right - cross.right];
      if (new Set(gaps).size > 1) return "the × stands " + gaps.join(", ") + " from the head's top, rule and right";
      const own = document.querySelector("#close").getBoundingClientRect();
      if (own.top !== gaps[0]) return "the window's own × stands " + own.top + " from the top, and this one " + gaps[0];
      const glyph = (at) => at.querySelector("path").getAttribute("d");
      if (glyph(x()) !== glyph(document.querySelector("#close"))) return "the × is drawn " + glyph(x());
      const parts = [style(box()).borderLeftWidth, style(box()).borderRightWidth, style(head()).paddingLeft, style(head()).columnGap, style(x()).width, style(x()).marginRight];
      const least = parts.reduce((sum, px) => sum + parseFloat(px), 0);
      if (least !== ${HEAD_LEAST_WIDTH}) return "a head's fixed parts come to " + least + "px";
      const caption = box().querySelector(".chart-caption").getBoundingClientRect();
      if (caption.height !== ${CAPTION}) return "the caption is " + caption.height + "px high";
      const foot = box().getBoundingClientRect().bottom - parseFloat(style(box()).borderBottomWidth);
      if (caption.bottom !== foot) return "the caption ends at " + caption.bottom + ", and the box at " + foot;
      const grip = box().querySelector(".chart-grip").getBoundingClientRect();
      if (grip.right !== cross.right) return "the grip ends at " + grip.right + ", and the × at " + cross.right;
      return text(".chart-title") === "Rows per Location" ? "" : "the head says " + text(".chart-title");
    `,
  },
  {
    name: "the pointer over a window's × fills it as over the window's own",
    hover: ".chart .chart-close",
    script: `
      ${CHROME}
      if (!(await until(() => x().matches(":hover")))) return "the pointer is over " + JSON.stringify(document.querySelector(":hover:not(:has(:hover))")?.className);
      const flag = computed("var(--flag)");
      const worn = [style(x()).backgroundColor, style(x()).borderTopColor, style(x()).color];
      const want = [flag, flag, computed("var(--surface)")];
      return worn.join() === want.join() ? "" : "the × wears " + worn.join(" and ");
    `,
  },
  {
    name: "the pointer over a window's grip takes it to the scrollbar thumb's hover colour",
    hover: ".chart .chart-grip",
    script: `
      ${CHROME}
      const grip = box().querySelector(".chart-grip");
      if (!(await until(() => grip.matches(":hover")))) return "the pointer is over " + JSON.stringify(document.querySelector(":hover:not(:has(:hover))")?.className);
      return style(grip).color === computed("var(--ink-3)") ? "" : "the grip is " + style(grip).color;
    `,
  },
  {
    name: "a long title ends in an ellipsis, and leaves the × where it stood",
    script: `
      ${CHROME}
      const title = box().querySelector(".chart-title");
      const said = title.textContent;
      const stood = x().getBoundingClientRect().left;
      title.textContent = said.repeat(${LONG_TITLE});
      const left = x().getBoundingClientRect().left;
      const [runs, shows] = [title.scrollWidth, title.clientWidth];
      title.textContent = said;
      if (left !== stood) return "the × moved from " + stood + " to " + left;
      if (runs <= shows) return "the title wraps, running " + runs + "px in " + shows + "px";
      return style(title).overflowX === "hidden" && style(title).textOverflow === "ellipsis" ? "" : "the title shows no ellipsis";
    `,
  },
  {
    // No run has a coarse pointer, so this lifts the rule out of its media query.
    name: `a finger gets ${FINGER} around a window's ×`,
    script: `
      ${CHROME}
      const inside = (rules) => [...rules].flatMap((rule) => [rule, ...inside(rule.cssRules ?? [])]);
      const rules = [...document.styleSheets].flatMap((sheet) => inside(sheet.cssRules));
      const reach = rules.find((rule) => rule.selectorText === ".chart-close::after");
      if (reach?.parentRule?.conditionText !== "(pointer: coarse)") return "the × has no rule for a finger";
      const lifted = document.createElement("style");
      lifted.textContent = reach.cssText;
      document.head.append(lifted);
      const { width, height } = getComputedStyle(x(), "::after");
      lifted.remove();
      return width === "${FINGER}" && height === "${FINGER}" ? "" : "a finger gets " + width + " by " + height;
    `,
  },
  {
    name: "a click on a window's head gives it the keys, and its border says so",
    input: { events: CLICK_HEAD, through: true },
    shot: "chart-focused",
    script: `
      ${CHROME}
      if (!(await until(() => document.activeElement === box()))) return "the keys are in " + document.activeElement?.tagName;
      const worn = style(box()).borderTopColor;
      const want = computed("color-mix(in srgb, var(--accent) 45%, transparent)");
      return worn === want ? "" : "the border is " + worn + ", and the formula primary's " + want;
    `,
  },
  {
    // After a key, focus from a script shows as it will when F6 moves it here.
    name: "a window given the keys from the keyboard draws no outline over its border",
    input: { events: A_KEY, through: true },
    script: `
      ${CHROME}
      const shows = () => {
        box().blur();
        box().focus();
        return box().matches(":focus-visible");
      };
      if (!(await until(shows))) return "the window does not show its focus, so this checks nothing";
      return style(box()).outlineStyle === "none" ? "" : "the window has the outline " + style(box()).outline;
    `,
  },
  {
    name: "a cell opens in transform, for the click after this",
    script: `
      await press("e", { ctrlKey: true });
      await press("Enter");
      return (await until(() => document.querySelector(".cell-editor") !== null)) ? "" : "no cell opened";
    `,
  },
  {
    name: "a click on a window's head commits an open cell and gives the window the keys",
    input: { events: CLICK_HEAD, through: true },
    script: `
      ${CHROME}
      if (!(await until(() => document.querySelector(".cell-editor") === null))) return "the cell stayed open";
      await frame();
      const keys = document.activeElement;
      await press("e", { ctrlKey: true });
      return keys === box() ? "" : "the keys are in #" + keys?.id;
    `,
  },
  {
    name: "the layer clips as far from a window as its shadow reaches, so the shadow fades before the clip",
    script: `
      ${CHROME}
      const layer = style(document.querySelector("#charts"));
      if (layer.overflowX !== "clip" || layer.overflowY !== "clip") return "the layer's overflow is " + layer.overflow;
      const [, offset, blur] = style(box()).boxShadow.match(/\\d+(?=px)/g).map(Number);
      const reach = offset + blur + "px";
      return layer.overflowClipMargin === reach ? "" : "the layer clips at " + layer.overflowClipMargin + ", and the shadow reaches " + reach;
    `,
  },
  {
    name: "a window's shadow takes no pointer from the scrollbar",
    script: `
      ${GEOMETRY}
      const [, foot] = windows();
      const under = document.elementFromPoint((foot.left + foot.right) / 2, foot.bottom + 1);
      return under.closest(".chart") === null ? "" : "a window lies over the scrollbar";
    `,
  },
  {
    // The sheet is held thin by hand, as a zoomed page with both columns open has it.
    name: "a room too narrow for a head shows no window, and leaves what is under it the pointer",
    script: `
      ${GEOMETRY}
      const sheet = document.querySelector(".win-sheet");
      const shows = () => getComputedStyle(document.querySelector(".chart")).visibility !== "hidden";
      sheet.style.maxWidth = ${THIN_SHEET} + "px";
      const thin = await until(() => !shows());
      const at = document.elementFromPoint(room().left + 1, room().top + 1);
      sheet.style.maxWidth = "";
      if (!thin) return "a window stands at " + edges(windows()[0]) + " in a room at " + edges(room());
      if (at.closest(".chart") !== null) return "a hidden window takes the pointer";
      return (await until(() => shows() && !heads())) ? "" : "the windows stayed hidden";
    `,
  },
  {
    // The sheet is held short by hand: main keeps the window taller than this.
    name: "tucked heads a short room cannot hold stop at its foot, and leave the scrollbar the pointer",
    script: `
      ${GEOMETRY}
      const sheet = document.querySelector(".win-sheet");
      const under = () => {
        const [, foot] = windows();
        return document.elementFromPoint((foot.left + foot.right) / 2, room().bottom + 1);
      };
      sheet.style.maxHeight = ${SHORT_SHEET} + "px";
      const stack = await until(() => heads() && windows()[1].bottom > room().bottom);
      const held = under();
      sheet.style.maxHeight = "";
      if (!stack) return "the windows stand at " + windows().map(edges).join(" and ") + " in a room at " + edges(room());
      if (held.closest(".chart") !== null) return "a head lies over the scrollbar";
      return (await until(() => !heads())) ? "" : "the windows stayed tucked";
    `,
  },
  {
    name: "the window with the keys stands over the head below it, so all of its border shows and no shadow falls on that head",
    script: `
      ${GEOMETRY}
      const sheet = document.querySelector(".win-sheet");
      const upper = document.querySelector(".chart");
      sheet.style.maxHeight = ${SHORT_SHEET} + "px";
      const stack = await until(heads);
      upper.focus();
      const [{ left, right, bottom }] = windows();
      const foot = document.elementFromPoint((left + right) / 2, bottom - border() / 2);
      const shadow = getComputedStyle(upper).boxShadow;
      sheet.style.maxHeight = "";
      if (!stack) return "the windows stand at " + windows().map(edges).join(" and ");
      if (!upper.contains(foot)) return "the head below lies over the border";
      if (shadow !== "none") return "the head with the keys throws " + shadow;
      return (await until(() => !heads())) ? "" : "the windows stayed tucked";
    `,
  },
];

/** A check near the run's end, as it opens a workspace in place of the one the others read. */
export const CHART_SIGNED: Check[] = [
  {
    name: "a sum with long values on both sides of zero keeps its bars at the least width, and its values inside their tracks",
    send: ["menu:open-path", SIGNED],
    shot: "chart-signed",
    script: `
      const tracks = () => [...document.querySelectorAll(".chart-bar-track")];
      if (!(await arrives(() => tracks().length === ${SIGNED_REGIONS}))) return "the plot draws " + tracks().length + " bars";
      const drawn = tracks().map((track) => {
        const [line, bar, tip] = [track, ...track.children].map((at) => at.getBoundingClientRect());
        return { below: track.classList.contains("below"), line, bar, tip };
      });
      const widest = (below) => Math.max(0, ...drawn.filter((at) => at.below === below).map(({ bar }) => bar.width));
      const span = widest(false) + widest(true);
      if (span < ${SPAN_LEAST}) return "the bars share " + span + " px of tracks " + drawn[0].line.width + " px wide";
      const out = drawn.find(({ line, tip }) => tip !== undefined && (tip.left < line.left || tip.right > line.right));
      return out === undefined ? "" : "a value runs from " + out.tip.left + " to " + out.tip.right + ", past its track's " + out.line.right;
    `,
  },
];

/** A check after CHART_SIGNED, as it opens a workspace of a scatter in place of that one. */
export const CHART_SCATTER: Check[] = [
  {
    name: "a scatter stands its points inside its axes in the accent, from a whole px, each tick's label centred on its gridline and clear of the others",
    send: ["menu:open-path", SCATTERED],
    shot: "chart-scatter",
    script: `
      ${GEOMETRY}
      ${CHROME}
      const all = (selector) => [...document.querySelectorAll(selector)];
      if (!(await arrives(() => all(".chart-point").length > 0))) return "the plot draws no points";
      const rect = (at) => at.getBoundingClientRect();
      const middle = (at) => ({ x: (at.left + at.right) / 2, y: (at.top + at.bottom) / 2 });
      const off = (a, b) => Math.abs(a - b) > ${RECT_SLACK};
      const grown = (at, by) => new DOMRect(at.left - by, at.top - by, at.width + 2 * by, at.height + 2 * by);
      const axes = rect(document.querySelector(".chart-points"));
      const centres = all(".chart-point").map((point) => middle(rect(point)));
      const strayed = centres.find(({ x, y }) => !within(new DOMRect(x, y), grown(axes, ${RECT_SLACK})));
      if (strayed !== undefined) return "a point stands at " + strayed.x + " " + strayed.y + ", past axes at " + edges(axes);
      const between = (at) => off(at, Math.round(at));
      const from = rect(document.querySelector(".chart"));
      if (between(axes.left - from.left) || between(axes.top - from.top)) return "the points start between px, at " + edges(axes) + " in a window at " + edges(from);
      for (const side of ["x", "y"]) {
        const lines = all(".chart-grid." + side).map((line) => middle(rect(line))[side]);
        const labels = all(".chart-ticks." + side + " .chart-tick").map((label) => middle(rect(label))[side]);
        const wrong = labels.findIndex((at, i) => off(at, lines[i]));
        if (lines.length < 2 || wrong !== -1) return side + "'s labels centre at " + labels.join() + ", and its gridlines at " + lines.join();
      }
      const ticks = all(".chart-tick").map(rect);
      const meet = (a, b) => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
      const met = ticks.flatMap((a, i) => ticks.slice(i + 1).filter((b) => meet(a, b)).map((b) => [a, b]));
      if (met.length > 0) return "labels meet at " + edges(met[0][0]) + " and " + edges(met[0][1]);
      const plot = rect(document.querySelector(".chart-plot"));
      const past = ticks.find((at) => !within(at, grown(plot, ${RECT_SLACK - BARS_INSET})));
      if (past !== undefined) return "a label at " + edges(past) + " runs into the inset of the plot at " + edges(plot);
      const [point, line] = [".chart-point", ".chart-grid"].map((at) => style(document.querySelector(at)));
      const worn = [point.fill, point.fillOpacity, line.stroke];
      const inks = [computed("var(--accent)"), "${POINT_OPACITY}", computed("var(--rule)")];
      return worn.join() === inks.join() ? "" : "a point and a gridline wear " + worn.join(" and ");
    `,
  },
  {
    name: "a scatter that samples says in its caption how many points it draws, whole before the grip",
    script: `
      const said = document.querySelector(".chart-said");
      const drawn = counted(document.querySelectorAll(".chart-point").length);
      if (!said.textContent.startsWith(drawn + " of ")) return "the caption says " + said.textContent + " of " + drawn + " points";
      return said.scrollWidth > said.clientWidth ? "the caption cuts " + said.textContent : "";
    `,
  },
];

/** The run's last check, as it opens a workspace of three scatters in place of the last. */
export const CHART_ALONG: Check[] = [
  {
    name: "a scatter's x axis writes its labels in full where they fit side by side, compactly in a window too narrow for that, and at every second tick where even those crowd, all clear of the y axis's",
    send: ["menu:open-path", ALONG],
    shot: "chart-along",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const along = (win) => [...win.querySelectorAll(".chart-ticks.x .chart-tick")];
      const drawn = () => windows().length === ${ALONG_LABELS.length} && windows().every((win) => along(win).length > 0);
      if (!(await arrives(drawn))) return "the windows draw no x axis";
      const said = windows().map((win) => along(win).map((label) => label.textContent));
      if (JSON.stringify(said) !== ${JSON.stringify(JSON.stringify(ALONG_LABELS))}) return "the x axes read " + JSON.stringify(said);
      for (const win of windows()) {
        const at = along(win).map((label) => label.getBoundingClientRect());
        const near = at.findIndex((label, i) => i > 0 && label.left - at[i - 1].right < ${TICK_GAP});
        if (near !== -1) return "two labels of " + said[windows().indexOf(win)].join() + " stand " + (at[near].left - at[near - 1].right) + " px apart";
        const [foot, first] = [".chart-ticks.y", ".chart-ticks.x"].map((axis) => win.querySelector(axis + " .chart-tick").getBoundingClientRect());
        if (first.top - foot.bottom < ${TICK_GAP - RECT_SLACK}) return "the x axis's first label stands " + (first.top - foot.bottom) + " px under the y axis's first";
      }
      return "";
    `,
  },
];
