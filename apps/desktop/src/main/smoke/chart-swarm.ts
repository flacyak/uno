/**
 * @fileoverview Checks of beeswarms in real layout: a strip per region, two
 * rows tall or more, its dots 8 px in the accent, none over another and all inside
 * their strip; and one strip of every amount, named for it, in a narrow window.
 *
 * They open the workspace smoke.js wrote of four regions' amounts.
 */

import { DOT, tallOf } from "@renderer/chart/swarm";
import { RECT_SLACK } from "./charts.ts";
import type { Check } from "./check.ts";

/** The workspace smoke.js wrote of two beeswarms. */
const SWARMED = process.env["UNO_SMOKE_SWARMED"] ?? "";

/** The regions of the box plots' amounts, which hold as many rows each. */
const REGIONS = 4;

/** How far two dots may close in from their packing's width to the track's measured one: half a px. */
const PX_SLACK = 0.5;

export const CHART_SWARM: Check[] = [
  {
    name: "a beeswarm draws a strip per region of 8 px accent dots, none over another and each inside its strip, and one strip of every amount",
    send: ["menu:open-path", SWARMED],
    shot: "chart-swarm",
    script: `
      const windows = () => [...document.querySelectorAll(".chart")];
      const drawn = () => windows().length === 2 && windows().every((win) => win.querySelector(".chart-swarm-dot") !== null);
      if (!(await arrives(drawn))) return "the windows draw no dots";
      const [byRegion, alone] = windows();
      const tracks = [...byRegion.querySelectorAll(".chart-swarm-track")];
      if (tracks.length !== ${REGIONS}) return "the beeswarm draws " + tracks.length + " strips";
      const labels = [...alone.querySelectorAll(".chart-bar-label")].map((label) => label.textContent);
      if (labels.join() !== "amount") return "the narrow window's strips read " + labels.join();
      const probe = document.createElement("div");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      for (const track of document.querySelectorAll(".chart-swarm-track")) {
        const strip = track.getBoundingClientRect();
        if (strip.height < ${tallOf(2)} - ${RECT_SLACK}) return "a strip stands " + strip.height + " px tall";
        const dots = [...track.querySelectorAll(".chart-swarm-dot")].map((dot) => dot.getBoundingClientRect());
        if (getComputedStyle(track.querySelector(".chart-swarm-dot")).backgroundColor !== accent) return "a dot wears another colour";
        for (const [i, dot] of dots.entries()) {
          if (Math.abs(dot.width - ${DOT}) > ${RECT_SLACK}) return "a dot is " + dot.width + " px wide";
          if (dot.top < strip.top - ${RECT_SLACK} || dot.bottom > strip.bottom + ${RECT_SLACK}) return "a dot stands past its strip";
          if (dot.left < strip.left - ${DOT} / 2 - ${RECT_SLACK} || dot.right > strip.right + ${DOT} / 2 + ${RECT_SLACK}) return "a dot stands past its track";
          for (const other of dots.slice(0, i)) {
            const apart = Math.hypot(dot.x - other.x, dot.y - other.y);
            if (apart < ${DOT} - ${PX_SLACK}) return "two dots stand " + apart + " px apart";
          }
        }
      }
      return "";
    `,
  },
];
