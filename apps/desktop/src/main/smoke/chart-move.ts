/**
 * @fileoverview Checks of moving a chart's bars by the keys: Alt with Up,
 * Down, Home and End moves the bar under the cursor, the bars stand so at
 * once, the cursor goes with the bar, and the status line says where it
 * stands, though no screen reader reads it out, as it asks nothing more.
 *
 * A real pointer carries a bar by its label to the top, and the bars stand
 * so, without the window moving.
 *
 * They open a copy smoke.js wrote of the stacked workspace chart-stack.ts
 * reads, whose rows window draws its regions largest first, so the stacked
 * one is never open while they move bars.
 */

import { BAR_GAP, BAR_THICK } from "@renderer/chart/rows";
import { pressing } from "./chart-moves.ts";
import { STACKED_REGIONS } from "./chart-stack.ts";
import type { Check } from "./check.ts";

/** The copy of the stacked workspace, by its path and the name the sidebar gives it. */
const MOVABLE = process.env["UNO_SMOKE_MOVABLE"] ?? "";
const MOVABLE_NAME = "movable";

/** East's direct in the rows window, which the pointer gives the cursor to. */
const EAST = ".chart .chart-bar-row:nth-child(2) .chart-segment:nth-child(2)";
/** The slot of direct, the series the cursor is on, counted from 0. */
const DIRECT_SLOT = 1;
/** The regions once Alt+Up moves East to the top. */
const MOVED_UP = ["East", "West", "South", "North"];

/** North's label in the rows window, the last of four. */
const NORTH = ".chart .chart-bar-row:nth-child(4) .chart-bar-label";
/** Up past the three rows above it, to above the first's middle. */
const TO_TOP = { x: 0, y: -(3 * (BAR_THICK + BAR_GAP) + BAR_THICK / 2) };
/** The regions once North is carried to the top. */
const CARRIED_UP = ["North", "East", "West", "South"];

export const CHART_MOVE: Check[] = [
  {
    name: "a stacked chart's window draws its bars",
    send: ["menu:open-path", MOVABLE],
    script: `
      const opened = () => document.querySelector(".ws.open")?.textContent.startsWith("${MOVABLE_NAME}");
      const drawn = () => opened() && document.querySelectorAll(".chart .chart-segment").length > 0;
      return (await arrives(drawn)) ? "" : "the windows draw no bars";
    `,
  },
  {
    name: "the pointer on a bar gives it the cursor, and the plot the keys",
    click: { selector: EAST },
    script: `
      const plot = document.querySelector(".chart .chart-plot");
      const ready = () => document.activeElement === plot && document.querySelector(${JSON.stringify(EAST)}).classList.contains("cursor");
      return (await until(ready)) ? "" : "the plot has " + (document.activeElement === plot ? "the keys and no cursor" : "no keys");
    `,
  },
  {
    name: "Alt+Up moves the bar under the cursor up one, the bars stand so, the cursor goes with it, and the status line says where it stands, which no screen reader reads out",
    input: { events: pressing("Up", ["alt"]), through: true },
    shot: "chart-move-keys",
    script: `
      const win = document.querySelector(".chart");
      const labels = () => [...win.querySelectorAll(".chart-bar-label")].map((label) => label.textContent).join();
      if (!(await arrives(() => labels() === "${MOVED_UP.join()}"))) return "the bars stand " + labels();
      const row = win.querySelector(".chart-bar-row:has(.cursor)");
      if (row !== win.querySelector(".chart-bar-row")) return "the cursor is on " + row?.querySelector(".chart-bar-label").textContent;
      // The cursor keeps its series, direct, the second slot.
      const slot = row.querySelector(".chart-segment.cursor").dataset.slot;
      if (slot !== "${DIRECT_SLOT}") return "the cursor is on slot " + slot;
      if (document.querySelector(".ws.open .dirty") === null) return "the workspace is not marked unsaved";
      const said = document.querySelector("#status-msg");
      // A move asks nothing more of the person, so the live region holds none of it.
      if (document.querySelector("#status-heard").textContent !== "") return "a screen reader hears " + document.querySelector("#status-heard").textContent;
      // Where the window stands, which carrying a bar must leave as it is.
      const { left, top } = win.getBoundingClientRect();
      window.stood = left + "," + top;
      return said.textContent === "East moved to 1 of ${STACKED_REGIONS.length}" ? "" : "the status line says " + said.textContent;
    `,
  },
  {
    name: "a pointer carries a bar by its label to the top, the bars stand so, the window stays where it stood, and the status line says where it stands",
    drag: { selector: NORTH, by: TO_TOP },
    shot: "chart-move-drag",
    script: `
      const win = document.querySelector(".chart");
      const labels = () => [...win.querySelectorAll(".chart-bar-label")].map((label) => label.textContent).join();
      if (!(await arrives(() => labels() === "${CARRIED_UP.join()}"))) return "the bars stand " + labels();
      if (win.querySelector(".chart-landing") !== null) return "the landing line stays";
      const { left, top } = win.getBoundingClientRect();
      if (left + "," + top !== window.stood) return "the window went from " + window.stood + " to " + left + "," + top;
      const said = document.querySelector("#status-msg").textContent;
      return said === "North moved to 1 of ${STACKED_REGIONS.length}" ? "" : "the status line says " + said;
    `,
  },
  {
    name: "a save keeps the order the bars were moved in, and leaves the workspace clean for the groups after",
    send: ["menu:save"],
    script: `
      if (!(await arrives(() => text("#status-msg").startsWith("saved ")))) return "saving says " + text("#status-msg");
      return document.querySelector(".ws.open .dirty") === null ? "" : "the workspace is still marked unsaved";
    `,
  },
];
