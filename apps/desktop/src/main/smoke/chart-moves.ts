/**
 * @fileoverview Checks of a chart window under a real pointer. A drag moves it by
 * the pointer's px, and the grip resizes it. None of it marks the workspace
 * unsaved.
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

/** A drag and a resize that fit the room at the run's 1100 px and at its 960 at scale 2. */
const CARRY = { x: -150, y: 60 };
const STRETCH = { x: -60, y: 40 };

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
];
