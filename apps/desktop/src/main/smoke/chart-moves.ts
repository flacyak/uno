/**
 * @fileoverview Checks of a chart window under a real pointer. A drag moves it by
 * the pointer's px, and the grip and the edges resize it. None of it marks the
 * workspace unsaved.
 *
 * They follow CHARTS, so the first window stands at the top of the room's right
 * edge and the second at its foot, and each picks up where the last left it.
 */

import { DEFAULT_HEIGHT, DEFAULT_WIDTH } from "@renderer/chart/place";
import { GEOMETRY, RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** Where the pointer takes hold to move or resize the first window. */
const HEAD = ".chart .chart-title";
const GRIP = ".chart .chart-grip";
const RIGHT_EDGE = ".chart .chart-edge-right";
const FOOT_EDGE = ".chart .chart-edge-foot";

/** A drag and a resize that fit the room at the run's 1100 px and at its 960 at scale 2. */
const CARRY = { x: -150, y: 60 };
const STRETCH = { x: -60, y: 40 };

/** What the two edges take off and add. */
const EDGE_PX = 30;

/** How far in from a window's corner a point stands inside its 8 px radius. */
const CORNER_IN = 4;

/** A point this far in from a window's box stands on its 1 px border. */
const BORDER_IN = 0.5;

/** The zone a finger gets at a window's edges and grip, as the design asks. */
const FINGER = 24;

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
];
