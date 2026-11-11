/**
 * @fileoverview Checks of a chart window under a real pointer and real keys. A
 * drag moves it by the pointer's px, the grip and the edges resize it, the least
 * size holds and the room's edges stop it, and Escape puts a drag back. The
 * arrows step it, and Escape gives the grid its keys back. A press raises it.
 * None of it marks the workspace unsaved, and Ctrl+S writes the places, which
 * smoke.js reads back. A finger gets 24 px at the zones and drags a head too, a
 * tucked head stays put, a press closes an open popup, and a drag from a window
 * selects nothing.
 *
 * They follow CHARTS, so the first window stands at the top of the room's right
 * edge and the second at its foot, and each picks up where the last left it.
 */

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  NUDGE_PX,
} from "@renderer/chart/place";
import { BORDER_IN, GEOMETRY, RECT_SLACK } from "./charts.ts";
import type { Check, Input } from "./check.ts";
import { RIGHT_CLICK } from "./sidebar.ts";

/** Where the pointer takes hold to move or resize the first window. */
const HEAD = ".chart .chart-title";
const GRIP = ".chart .chart-grip";
const RIGHT_EDGE = ".chart .chart-edge-right";
const FOOT_EDGE = ".chart .chart-edge-foot";

/** The second window's head, grip and plot. */
const LAST_HEAD = ".chart:last-child .chart-title";
const LAST_GRIP = ".chart:last-child .chart-grip";
const LAST_PLOT = ".chart:last-child .chart-plot";

/** A drag and a resize that fit the room at the run's 1100 px and at its 960 at scale 2. */
const CARRY = { x: -150, y: 60 };
const STRETCH = { x: -60, y: 40 };

/** A drag away from the room's foot right. */
const CARRY_BACK = { x: CARRY.x, y: -CARRY.y };

/** What the two edges take off and add. */
const EDGE_PX = 30;

/** What a resize takes off the sheet each way, which leaves a moved window's place between px. */
const SHEET_STEP = 1;

/** How far in from a window's corner a point stands inside its 8 px radius. */
const CORNER_IN = 4;

/** Past any edge of any room in this run. */
const FAR = 2000;

/** A point over the grid, which a held drag lets go of. */
const OVER_GRID = { x: 400, y: 300 };

/** The row the selection stands on from CHARTS, and the one below it. */
const ROW_BELOW = 12;

/** The zone a finger gets at a window's edges and grip, as the design asks. */
const FINGER = 24;

/** How many presses of an arrow take a finger's drag back across. */
const STEPS_BACK = 2;

/** A finger's drag, up and left from the room's foot right. */
const FINGER_STEP = { x: -STEPS_BACK * NUDGE_PX, y: -40 };

/** A sheet too short to show a window whole. */
const SHORT_SHEET = 80;

/** A point this far up from a window's foot stands in a 6 px edge zone. */
const EDGE_REACH = 3;

/** The line under a window at its least size: the second export's two least Locations. */
const LEAST_REST = "+2 more · 1,283 rows";

/** A drag from the last window's plot out over the sheet. */
const OVER_SHEET = { x: -500, y: -60 };

/** A right click on the open workspace. */
const ON_WORKSPACE = `rightClick(document.querySelector(".ws.open"));`;

/** What a press on a window closes: how each opens, and what shows while it is open. */
const POPUPS = [
  { popup: "a menu", opens: ON_WORKSPACE, shows: ".pop-menu" },
  {
    popup: "the settings menu",
    opens: `document.querySelector("#settings").click();`,
    shows: ".settings:not([hidden])",
  },
  {
    popup: "the formula form",
    opens: `${ON_WORKSPACE} await frame(); choose("Insert formula…");`,
    shows: ".formula",
  },
];

/** What each of POPUPS is pressed away with, and the name a check gives it. */
const PRESSED = [
  { part: "head", zone: LAST_HEAD },
  { part: "grip", zone: LAST_GRIP },
];

/** A press of `keyCode` with `modifiers`. */
export function pressing(
  keyCode: string,
  modifiers: Array<"shift" | "control"> = [],
): readonly Input[] {
  return [
    { type: "keyDown", keyCode, modifiers },
    { type: "keyUp", keyCode, modifiers },
  ];
}

/** Helpers: the first window, and whether it stands where a check wants it. */
const MOVES = `
  ${GEOMETRY}
  const first = () => windows()[0];
  const near = (a, b) => Math.abs(a - b) < ${RECT_SLACK};
  const stands = (want) => Object.entries(want).every(([side, at]) => near(first()[side], at));
  const reads = () => edges(first()) + " in a room at " + edges(room());
  const wait = async (want, doing) => {
    if (!(await until(() => stands(want)))) return "the window stands at " + reads();
    return unsaved() ? doing + " marked the workspace unsaved" : "";
  };
`;

/** Helpers: the two windows, and what stands at the first one's middle, which both cover. */
const STACK = `
  ${GEOMETRY}
  const boxes = [...document.querySelectorAll(".chart")];
  const shared = () => {
    const { left, right, top, bottom } = windows()[0];
    return document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  };
`;

/**
 * For each of POPUPS and PRESSED, a check opens it and the next presses the zone
 * for real, as what closes a popup listens for the mousedown a pointerdown leaves
 * uncancelled. A popup starts to listen on its next tick, so the first waits a frame.
 */
const PRESSES: Check[] = POPUPS.flatMap(({ popup, opens, shows }) =>
  PRESSED.flatMap(({ part, zone }) => [
    {
      name: `${popup} opens over the windows, for a press on the ${part}`,
      script: `
        ${RIGHT_CLICK}
        ${opens}
        await frame();
        return document.querySelector(${JSON.stringify(shows)}) === null ? "nothing opened" : "";
      `,
    },
    {
      name: `a press on a window's ${part} closes ${popup}, and the window takes the keys`,
      drag: { selector: zone, by: { x: 0, y: 0 } },
      script: `
        if (!(await until(() => document.querySelector(${JSON.stringify(shows)}) === null))) return "it stayed open";
        const box = document.querySelector(".chart:last-child");
        return (await until(() => document.activeElement === box)) ? "" : "the keys are in #" + document.activeElement?.id;
      `,
    },
  ]),
);

export const CHART_MOVES: Check[] = [
  {
    name: "a drag on a head moves a window by the pointer's px, and marks nothing unsaved",
    drag: { selector: HEAD, by: CARRY },
    script: `
      ${MOVES}
      return wait({ right: room().right + ${CARRY.x}, top: room().top + ${CARRY.y} }, "a move");
    `,
  },
  {
    name: "a moved window stands on whole px after the sheet resizes, and goes back with it",
    script: `
      ${MOVES}
      const sheet = document.querySelector(".win-sheet");
      const inRoom = () => ({ x: first().left - room().left, y: first().top - room().top });
      const was = room();
      const { width, height } = sheet.getBoundingClientRect();
      sheet.style.maxWidth = width - ${SHEET_STEP} + "px";
      sheet.style.maxHeight = height - ${SHEET_STEP} + "px";
      const shrunk = () => near(room().width, was.width - ${SHEET_STEP}) && near(room().height, was.height - ${SHEET_STEP});
      const resized = await until(shrunk);
      // The layer places its windows again on the frame after the room resizes.
      await frame();
      const now = inRoom();
      sheet.style.maxWidth = "";
      sheet.style.maxHeight = "";
      if (!resized) return "the room stayed at " + edges(room());
      const whole = (px) => near(px, Math.round(px));
      if (!whole(now.x) || !whole(now.y)) return "the window stands between px, at " + now.x + " " + now.y + " in the room";
      return wait({ right: room().right + ${CARRY.x}, top: room().top + ${CARRY.y} }, "a resize");
    `,
  },
  {
    name: "a drag on the grip resizes a window from its top left",
    drag: { selector: GRIP, by: STRETCH },
    script: `
      ${MOVES}
      const corner = { left: room().right + ${CARRY.x - DEFAULT_WIDTH}, top: room().top + ${CARRY.y} };
      return wait({ ...corner, width: ${DEFAULT_WIDTH + STRETCH.x}, height: ${DEFAULT_HEIGHT + STRETCH.y} }, "a resize");
    `,
  },
  {
    name: "the right edge takes a window's width alone",
    drag: { selector: RIGHT_EDGE, by: { x: EDGE_PX, y: EDGE_PX } },
    script: `
      ${MOVES}
      const width = ${DEFAULT_WIDTH + STRETCH.x + EDGE_PX};
      return wait({ width, height: ${DEFAULT_HEIGHT + STRETCH.y} }, "a resize");
    `,
  },
  {
    name: "the foot edge takes a window's height alone",
    drag: { selector: FOOT_EDGE, by: { x: EDGE_PX, y: -EDGE_PX } },
    script: `
      ${MOVES}
      const width = ${DEFAULT_WIDTH + STRETCH.x + EDGE_PX};
      return wait({ width, height: ${DEFAULT_HEIGHT + STRETCH.y - EDGE_PX} }, "a resize");
    `,
  },
  {
    name: "the corner takes both ways, each edge one with its border, and the head's end is no edge",
    script: `
      ${MOVES}
      const at = (x, y) => document.elementFromPoint(x, y);
      const { left, right, top, bottom } = first();
      const zones = [
        [at(right - ${CORNER_IN}, bottom - ${CORNER_IN}), ".chart-grip", "nwse-resize"],
        [at(right - ${CORNER_IN}, (top + bottom) / 2), ".chart-edge-right", "ew-resize"],
        [at((left + right) / 2, bottom - ${CORNER_IN}), ".chart-edge-foot", "ns-resize"],
        [at(right - ${CORNER_IN}, top + ${CORNER_IN}), ".chart-head", "move"],
        [at(right - ${BORDER_IN}, (top + bottom) / 2), ".chart-edge-right", "ew-resize"],
        [at((left + right) / 2, bottom - ${BORDER_IN}), ".chart-edge-foot", "ns-resize"],
      ];
      const off = zones.flatMap(([hit, zone, cursor]) => {
        const worn = getComputedStyle(hit.closest(zone) ?? hit);
        const held = hit.closest(zone) === null ? zone + " is under " + hit.className : "";
        const look = worn.cursor === cursor ? "" : zone + " shows " + worn.cursor;
        return [held, look].filter((said) => said !== "");
      });
      return off.join(" · ");
    `,
  },
  {
    // A window that has never had the keys has no z-index of its own, so its grip
    // would stand over a window on top of it.
    name: "a window keeps its grip's stacking to itself",
    script: `
      const worn = getComputedStyle(document.querySelector(".chart:last-child"));
      return worn.isolation === "isolate" ? "" : "a window's isolation is " + worn.isolation;
    `,
  },
  {
    // No run has a coarse pointer, so this lifts the rule out of its media query.
    name: `a finger gets ${FINGER}px at a window's edges and grip, and pans nothing there`,
    script: `
      const box = document.querySelector(".chart");
      const inside = (rules) => [...rules].flatMap((rule) => [rule, ...inside(rule.cssRules ?? [])]);
      const rules = [...document.styleSheets].flatMap((sheet) => inside(sheet.cssRules));
      const reach = rules.find((rule) => rule.selectorText === ".chart" && rule.parentRule?.conditionText === "(pointer: coarse)");
      if (reach === undefined) return "a window has no rule for a finger";
      const zones = [".chart-head", ".chart-grip", ".chart-edge-right", ".chart-edge-foot"];
      const panning = zones.filter((zone) => getComputedStyle(box.querySelector(zone)).touchAction !== "none");
      if (panning.length > 0) return panning.join(", ") + " would pan under a finger";
      const lifted = document.createElement("style");
      lifted.textContent = reach.cssText;
      document.head.append(lifted);
      const edge = getComputedStyle(box.querySelector(".chart-edge-right")).width;
      const foot = getComputedStyle(box.querySelector(".chart-edge-foot")).height;
      const corner = box.getBoundingClientRect();
      const hit = document.elementFromPoint(corner.right - ${FINGER}, corner.bottom - ${FINGER});
      lifted.remove();
      if (hit.closest(".chart-grip") === null) return "a finger ${FINGER}px from the corner is on " + hit.className;
      const want = "${FINGER}px";
      return edge === want && foot === want ? "" : "the edges reach " + edge + " and " + foot;
    `,
  },
  {
    name: "the least size holds, however far the grip goes",
    drag: { selector: GRIP, by: { x: -FAR, y: -FAR } },
    script: `
      ${MOVES}
      return wait({ width: ${MIN_WIDTH}, height: ${MIN_HEIGHT} }, "a resize");
    `,
  },
  {
    name: "at its least size a window draws the bars its plot holds, and the line of the rest inside it",
    shot: "chart-least",
    script: `
      const plot = document.querySelector(".chart .chart-plot");
      const line = () => plot.querySelector(".chart-bars-line");
      const drawn = () => plot.querySelectorAll(".chart-bar").length + " bars and " + JSON.stringify(line()?.textContent);
      if (!(await until(() => line()?.textContent === ${JSON.stringify(LEAST_REST)}))) return "the plot draws " + drawn();
      const [foot, end] = [plot, line()].map((at) => at.getBoundingClientRect().bottom);
      return end <= foot ? "" : "the line ends at " + end + ", past the plot's foot at " + foot;
    `,
  },
  {
    name: "a drag past the room's top left stops on it",
    drag: { selector: HEAD, by: { x: -FAR, y: -FAR } },
    script: `
      ${MOVES}
      return wait({ left: room().left, top: room().top }, "a move");
    `,
  },
  {
    name: "a drag past the room's foot right stops on it",
    drag: { selector: HEAD, by: { x: FAR, y: FAR } },
    script: `
      ${MOVES}
      return wait({ right: room().right, bottom: room().bottom }, "a move");
    `,
  },
  {
    name: "a window follows the pointer while the button is down",
    drag: { selector: HEAD, by: CARRY_BACK, held: true },
    script: `
      ${MOVES}
      const bottom = room().bottom + ${CARRY_BACK.y};
      return wait({ right: room().right + ${CARRY_BACK.x}, bottom }, "a drag");
    `,
  },
  {
    name: "Escape puts a drag back, keeps the window's keys, and the rest of the drag does nothing",
    input: {
      events: [
        ...pressing("Escape"),
        { type: "mouseMove", ...OVER_GRID, modifiers: ["leftbuttondown"] },
        { type: "mouseUp", ...OVER_GRID, button: "left", clickCount: 1 },
      ],
      through: true,
    },
    script: `
      ${MOVES}
      const failed = await wait({ right: room().right, bottom: room().bottom }, "Escape");
      if (failed !== "") return failed;
      await frame();
      const box = document.querySelector(".chart");
      if (document.activeElement !== box) return "the keys are in #" + document.activeElement?.id;
      return stands({ right: room().right, bottom: room().bottom }) ? "" : "the drag went on to " + reads();
    `,
  },
  {
    name: "an arrow steps a window",
    input: { events: pressing("Left"), through: true },
    script: `
      ${MOVES}
      return wait({ right: room().right - ${NUDGE_PX} }, "a press");
    `,
  },
  {
    name: "Shift and an arrow resize a window",
    input: { events: pressing("Right", ["shift"]), through: true },
    script: `
      ${MOVES}
      return wait({ right: room().right, width: ${MIN_WIDTH + NUDGE_PX} }, "a press");
    `,
  },
  {
    name: "an arrow up keeps a window's height",
    input: { events: pressing("Up"), through: true },
    script: `
      ${MOVES}
      return wait({ bottom: room().bottom - ${NUDGE_PX}, height: ${MIN_HEIGHT} }, "a press");
    `,
  },
  {
    // Held to its least size by the checks above, so a step keeps inside the room.
    // A pan would cancel the pointer and put the window back.
    name: "a finger drags a window by its head, where it would pan the page",
    touch: { selector: HEAD, by: FINGER_STEP },
    script: `
      ${MOVES}
      const was = { right: room().right, bottom: room().bottom - ${NUDGE_PX} };
      const right = was.right + ${FINGER_STEP.x};
      return wait({ right, bottom: was.bottom + ${FINGER_STEP.y} }, "a finger's move");
    `,
  },
  {
    name: "a finger's drop leaves a window for the keys to step back",
    input: {
      events: Array.from({ length: STEPS_BACK }).flatMap(() => pressing("Right")),
      through: true,
    },
    script: `
      ${MOVES}
      const right = room().right + ${FINGER_STEP.x + STEPS_BACK * NUDGE_PX};
      return wait({ right, bottom: room().bottom + ${FINGER_STEP.y - NUDGE_PX} }, "a press");
    `,
  },
  {
    // The sheet is held short by hand: main keeps the window taller than this. The
    // grid takes the keys, so the next check can see its press land.
    name: "a tucked head shows no way to move it, and its foot takes no resize",
    input: { events: pressing("Escape"), through: true },
    script: `
      ${MOVES}
      const grid = document.querySelector("#content");
      if (!(await until(() => document.activeElement === grid))) return "the keys are in #" + document.activeElement?.id;
      document.querySelector(".win-sheet").style.maxHeight = ${SHORT_SHEET} + "px";
      if (!(await until(heads))) return "the windows stand at " + windows().map(edges).join(" and ");
      const { left, right, bottom } = first();
      const hit = document.elementFromPoint((left + right) / 2, bottom - ${EDGE_REACH});
      if (hit.closest(".chart-head") === null) return "the head's foot is " + hit.className;
      const { cursor } = getComputedStyle(hit.closest(".chart-head"));
      return cursor === "default" ? "" : "a tucked head shows " + cursor;
    `,
  },
  {
    name: "a drag on a tucked head leaves it and takes the keys, and it goes back to its place",
    drag: { selector: HEAD, by: CARRY },
    script: `
      ${MOVES}
      const box = document.querySelector(".chart");
      const keys = await until(() => document.activeElement === box);
      const stayed = stands({ top: room().top });
      document.querySelector(".win-sheet").style.maxHeight = "";
      if (!keys) return "the keys are in #" + document.activeElement?.id;
      if (!stayed) return "the tucked window went to " + reads();
      return wait({ width: ${MIN_WIDTH + NUDGE_PX}, height: ${MIN_HEIGHT} }, "tucking");
    `,
  },
  {
    name: "Escape gives the grid the keys back",
    input: { events: pressing("Escape"), through: true },
    script: `
      const grid = document.querySelector("#content");
      return (await until(() => document.activeElement === grid)) ? "" : "the keys are in #" + document.activeElement?.id;
    `,
  },
  {
    name: "the grid's arrows work again",
    input: { events: pressing("Down"), through: true },
    script: `
      const cell = () => text("#status-cell");
      return (await until(() => cell().endsWith("row ${ROW_BELOW}"))) ? "" : "the selection is at " + cell();
    `,
  },
  {
    name: "a window raised once stands over one later in the page, with the keys gone",
    script: `
      ${STACK}
      return shared().closest(".chart") === boxes[0] ? "" : "the window is under " + shared().className;
    `,
  },
  {
    name: "a press on a window under another raises it, with the windows in their order",
    drag: { selector: LAST_HEAD, by: { x: 0, y: 0 } },
    script: `
      ${STACK}
      const [under, over] = boxes;
      if (!(await until(() => over.contains(shared())))) return "the raised window is under " + shared().className;
      if (document.activeElement !== over) return "the keys are in #" + document.activeElement?.id;
      if (document.querySelector(".chart") !== under) return "the windows changed order";
      return unsaved() ? "a raise marked the workspace unsaved" : "";
    `,
  },
  {
    name: "a raised window stays over the others once the grid has the keys back",
    input: { events: pressing("Escape"), through: true },
    script: `
      ${STACK}
      const grid = document.querySelector("#content");
      if (!(await until(() => document.activeElement === grid))) return "the keys are in #" + document.activeElement?.id;
      return boxes[1].contains(shared()) ? "" : "the raised window went under " + shared().className;
    `,
  },
  {
    name: "Ctrl+S writes the windows' places, and marks nothing",
    input: { events: pressing("S", ["control"]), through: true },
    script: `
      ${MOVES}
      const said = () => text("#status-msg");
      if (!(await until(() => said().includes("charted.uno")))) return "the status says " + JSON.stringify(said());
      return unsaved() ? "the save left a mark" : "";
    `,
  },
  ...PRESSES,
  {
    // The window has the keys already, so only the frames say the press has landed.
    name: "a drag from a window's plot selects nothing, and no press on its border can",
    drag: { selector: LAST_PLOT, by: OVER_SHEET },
    script: `
      for (let i = 0; i < SETTLE_FRAMES; i++) await frame();
      const selection = getSelection();
      if (!selection.isCollapsed) return "the drag selected " + selection.toString().length + " characters";
      const { userSelect } = getComputedStyle(document.querySelector(".chart"));
      return userSelect === "none" ? "" : "a window's border selects: " + userSelect;
    `,
  },
];
