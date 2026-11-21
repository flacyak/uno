/**
 * @fileoverview A horizon chart's drawing: three bands of one scale, each
 * folded into its row over the last, and below zero the same in the pole's
 * steps.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { HORIZON_BANDS, horizonRow } from "@renderer/chart/horizon";

/** Each row's bands' paths, the accent's first, then the pole's. */
const bandsOf = (drawn: HTMLElement): string[][] =>
  [...drawn.querySelectorAll(".chart-horizon-bands")].map((bands) =>
    [...bands.querySelectorAll("path")].map((p) => `${p.style.fill} ${p.getAttribute("d")}`),
  );

test("a horizon row folds its amounts into three bands of one scale, darker over lighter, and below zero in the pole's", () => {
  // The most is 6, so each band is 2: 6 fills all three, 3 one and a half, -2 the pole's first.
  const [row] = bandsOf(horizonRow([6, 3, -2]));
  expect(row).toHaveLength(2 * HORIZON_BANDS);
  expect(row!.slice(0, HORIZON_BANDS)).toEqual([
    "var(--seq-2) M0 1V0H1V0H2V1H3V1Z",
    "var(--seq-3) M0 1V0H1V0.5H2V1H3V1Z",
    "var(--seq-4) M0 1V0H1V1H2V1H3V1Z",
  ]);
  expect(row![HORIZON_BANDS]).toBe("var(--div-2) M0 1V1H1V1H2V0H3V1Z");
  expect(bandsOf(horizonRow([0]))).toEqual([
    [
      "var(--seq-2) M0 1V1H1V1Z",
      "var(--seq-3) M0 1V1H1V1Z",
      "var(--seq-4) M0 1V1H1V1Z",
      "var(--div-2) M0 1V1H1V1Z",
      "var(--div-3) M0 1V1H1V1Z",
      "var(--div-4) M0 1V1H1V1Z",
    ],
  ]);
});
