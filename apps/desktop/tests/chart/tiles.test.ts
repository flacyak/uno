/**
 * @fileoverview The chart form's kind tiles: a row per question, a radio per
 * kind under one name and one group, the first chosen until another is.
 *
 * @vitest-environment happy-dom
 */

import { expect, test } from "vite-plus/test";

import { m } from "@paraglide/messages";
import { KindTiles, QUESTIONS } from "@renderer/chart/tiles";
import { PopForm } from "@renderer/shell/form";

/** The radios of `tiles`, as each kind's value and words. */
const radios = (tiles: KindTiles): HTMLInputElement[] => [
  ...tiles.box.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];

test("each question is a row of its kinds' tiles, one radio group the form names", () => {
  const tiles = new KindTiles(QUESTIONS);
  const rows = [...tiles.box.querySelectorAll(".field")].map((row) => [
    row.querySelector(".what")!.textContent,
    ...[...row.querySelectorAll(".chart-tile")].map((tile) => tile.textContent),
  ]);
  expect(rows).toStrictEqual([
    [
      m.chart_kinds_compare(),
      m.chart_kind_bars(),
      m.chart_kind_dots(),
      m.chart_kind_slope(),
      m.chart_kind_pie(),
    ],
    [
      m.chart_kinds_trend(),
      m.chart_kind_time(),
      m.chart_kind_week(),
      m.chart_kind_heat(),
      m.chart_kind_horizon(),
    ],
    [m.chart_kinds_spread(), m.chart_kind_histogram(), m.chart_kind_box(), m.chart_kind_swarm()],
    [m.chart_kinds_relate(), m.chart_kind_scatter(), m.chart_kind_parallel()],
  ]);
  expect(tiles.box.getAttribute("role")).toBe("radiogroup");
  expect(tiles.box.getAttribute("aria-label")).toBe(m.chart_form_kind());
  expect(new Set(radios(tiles).map((radio) => radio.name)).size).toBe(1);
});

test("the first kind is chosen until another is, and a kind turned off cannot be", () => {
  const tiles = new KindTiles(QUESTIONS);
  expect(tiles.value).toBe("bars");
  tiles.value = "scatter";
  expect(
    radios(tiles)
      .filter((radio) => radio.checked)
      .map((radio) => radio.value),
  ).toStrictEqual(["scatter"]);
  tiles.disable("time", true);
  expect(radios(tiles).find((radio) => radio.value === "time")!.disabled).toBe(true);
});

test("Tab stops once on a form's radio group, at the kind chosen", () => {
  document.body.innerHTML = "";
  const tiles = new KindTiles(QUESTIONS);
  tiles.value = "pie";
  const before = document.createElement("select");
  const after = document.createElement("select");
  const form = new PopForm("tiles", "", "", "", {
    submit: () => undefined,
    enters: () => false,
    closed: () => undefined,
  });
  form.open([before, tiles.box, after], { left: 0, top: 0 });
  before.focus();
  const tab = () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
  tab();
  expect(document.activeElement).toBe(radios(tiles).find((radio) => radio.value === "pie"));
  tab();
  expect(document.activeElement).toBe(after);
  form.close();
});
