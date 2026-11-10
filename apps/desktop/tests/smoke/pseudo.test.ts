/**
 * @fileoverview The real shell over the real engine in the pseudo-locale: every
 * word on screen must come through a message.
 *
 * A pseudo-message is accented and in brackets. After the language changes
 * to it, any plain letters left in the window are hard-coded English, or a
 * label left as drawn before the change.
 *
 * Text from the file, and names that are the same in every language, are
 * excluded below.
 *
 * @vitest-environment happy-dom
 */

import { mkdtempSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeAll, expect, test } from "vite-plus/test";

import { PSEUDO_CLOSE, PSEUDO_LOCALE, PSEUDO_OPEN } from "@scripts/pseudo";
import { m } from "@paraglide/messages";
import { baseLocale } from "@paraglide/runtime";
import { madeTitle } from "@renderer/chart/window";
import type { Shell } from "@renderer/shell/shell";
import { multiProvider } from "@store";
import { diskProvider } from "@store/node";
import {
  ADS,
  BARS,
  DEVICES,
  SALES,
  SCATTER,
  SHORT_ROWS,
  carriedUnoOf,
  holding,
  partsUnoOf,
  unoOf,
} from "../charted.ts";
import { FIXTURE, bootShell } from "./dom-harness.ts";
import { domPage, frame, until } from "./dom-page.ts";

/**
 * Selectors for text the app leaves as written: the file's cells
 * and column names, and a language's own name on a settings item with a
 * `lang` of its own.
 */
const NOT_THE_APPS = [
  "tbody",
  ".colhead",
  ".panel-peek table",
  ".formula select",
  // The chart form's sources and columns.
  ".chart-form .from-file",
  // What a chart's window takes from the file: a source's name, a person's title.
  ".chart .from-file",
  "[data-language][lang]",
  // A policy document, which is JSON the same in every language.
  ".policy .document",
];

/**
 * Elements where one message spans several children, read as one text: the
 * empty state's line, with its link in the middle.
 */
const ONE_SENTENCE = ["#empty p"];

/** The attributes a person reads or hears, beside the text itself. */
const SPOKEN = ["title", "aria-label", "aria-roledescription", "placeholder"];

/** The chart form's Refresh option that shows a number and a unit, and one
 * that checks the source every 15 minutes. */
const EVERY = "every";
const QUARTER_HOUR = 15;

/**
 * Patterns for text that is the same in every language, removed from a text
 * once its messages are taken out.
 */
const UNTRANSLATED: readonly RegExp[] = [
  // The fixture's name, as a tab, a workspace and a path.
  /\S*sales-q3\S*/g,
  // The second fixture's name, as a chart's head says it.
  /google-ads-sales/g,
  // A column's kind and the formula badge, which are the engine's names.
  /\b(date|text|num|fx)\b/g,
  // Keys and chords, as printed on a keyboard.
  /\b(?:Ctrl|Shift|Esc)(?:\+(?:Shift|[A-Z]))*\b/g,
  // The themes' names and the product's.
  /Paper Ember|Tokyo Night|Sakura|Catppuccin Frappé|T3 Themes|uno\b/g,
  // The example bucket, a provider and a profile: AWS names.
  /acme-exports|\bs3\b|\bdefault\b|~\/\.aws/g,
  // The example role's ARN.
  /arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+/g,
  // The file extensions the empty state lists.
  /\b(csv|tsv)\b/g,
  // The encoding's name.
  /UTF-8/g,
];

/** One innermost message. `plain` removes these repeatedly, so a message
 * holding another is taken out whole. */
const MESSAGE = new RegExp(`${PSEUDO_OPEN}[^${PSEUDO_OPEN}${PSEUDO_CLOSE}]*${PSEUDO_CLOSE}`, "g");

/** What is left of a text after its messages and untranslated names are
 * removed, or "" once every letter is gone. */
function plain(text: string): string {
  let rest = text;
  for (let was = ""; was !== rest;) {
    was = rest;
    rest = rest.replace(MESSAGE, "");
  }
  for (const name of UNTRANSLATED) rest = rest.replace(name, "");
  return /\p{L}/u.test(rest) ? rest.trim() : "";
}

/** Every text and spoken attribute `within` a selector with plain letters left in it. */
function english(within = "body"): string[] {
  const found: string[] = [];
  const sentences = ONE_SENTENCE.join(",");
  const all = `${within}, ${within} *`;
  for (const el of document.documentElement.querySelectorAll<HTMLElement>(all)) {
    if (el.closest(NOT_THE_APPS.join(",")) !== null) continue;
    const tag = `<${el.tagName.toLowerCase()} class="${el.className}">`;
    // A sentence across several elements is read once, at its root.
    const texts = el.matches(sentences)
      ? [el.textContent]
      : el.closest(sentences) !== null
        ? []
        : [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent);
    for (const text of texts) {
      const left = plain(text ?? "");
      if (left !== "") found.push(`${tag} ${left}`);
    }
    for (const name of SPOKEN) {
      const left = plain(el.getAttribute(name) ?? "");
      if (left !== "") found.push(`${name} of ${tag} ${left}`);
    }
  }
  return found;
}

const click = (selector: string): void => {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`nothing matches ${selector}`);
  el.click();
};

let shell: Shell;

beforeAll(async () => {
  // A source over several files reads through the disk as one.
  const disk = diskProvider();
  shell = await bootShell({}, [disk, multiProvider([disk])]);
  // Open everything that can be on screen in English first, so the check is
  // that changing the language redraws each of them.
  click("#panel-toggle");
  click("#settings");
  await frame();
  shell.language.choose(PSEUDO_LOCALE);
  await frame();
}, 20_000);

test("the window is in the language chosen", () => {
  expect(document.documentElement.lang).toBe(PSEUDO_LOCALE);
  expect(document.querySelector(".sidebar-head")?.textContent).toBe(m.workspaces_title());
  expect(m.workspaces_title().startsWith(PSEUDO_OPEN)).toBe(true);
});

test("an open file, the sidebar, the sources panel and settings say nothing in plain English", () => {
  expect(document.querySelector(".settings")?.hasAttribute("hidden")).toBe(false);
  expect(document.querySelector("#panel")?.hasAttribute("hidden")).toBe(false);
  expect(english()).toEqual([]);
});

test("transform, and what a locked key says in view, are in the language chosen", async () => {
  click("#settings");
  click('#mode-switch [data-mode="transform"]');
  await frame();
  expect(document.querySelector("#status-mode")?.textContent).toBe(m.mode_transform());
  expect(english()).toEqual([]);
});

test("the form that connects a bucket is in the language chosen", async () => {
  const connect = [...document.querySelectorAll<HTMLElement>("#panel .panel-row.action")][0];
  connect?.click();
  await frame();
  expect(document.querySelector(".panel-connect")?.hasAttribute("hidden")).toBe(false);
  expect(english()).toEqual([]);
});

test("a right click on the workspace offers its menu in the language chosen", async () => {
  const row = document.querySelector<HTMLElement>("#workspaces .ws");
  row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await frame();
  expect(document.querySelectorAll(".pop-item").length).toBeGreaterThan(0);
  expect(english()).toEqual([]);
});

test("the chart form is in the language chosen", async () => {
  const items = [...document.querySelectorAll<HTMLElement>(".pop-item")];
  items.find((item) => item.firstChild?.textContent === m.menu_insert_chart())?.click();
  expect(await until(domPage(), () => document.querySelector(".chart-form") !== null)).toBe(true);
  expect(english()).toEqual([]);
  // Enter on Every… with no number says what it takes.
  const refresh = document.querySelector<HTMLSelectElement>('.chart-form select[name="refresh"]')!;
  refresh.value = EVERY;
  refresh.dispatchEvent(new Event("change"));
  refresh.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(english()).toEqual([]);
  // A schedule's note says what a check reads.
  refresh.value = String(QUARTER_HOUR);
  refresh.dispatchEvent(new Event("change"));
  expect(english()).toEqual([]);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  document.querySelector(".chart-form")?.dispatchEvent(escape);
});

test("what a .uno's charts say in the status line is in the language chosen", async () => {
  const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
  const carried = { id: "c2", source: SALES, json: '{"id":"c2"}' };
  const path = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "q3.uno");
  await writeFile(path, unoOf([BARS], [carried]));
  await shell.openRef({ name: "q3.uno", path });
  expect(message()).toBe(m.charts_kept({ count: 1 }));
  expect(plain(message())).toBe("");

  click(`.tab[data-source="${SALES}"] .close`);
  expect(message()).toBe(m.source_takes_charts({ name: `${SALES}.csv` }));
  expect(plain(message())).toBe("");
});

test("a chart's window drawn in English is rewritten in the language chosen", async () => {
  // Two charts name a column the second export has not, so they draw nothing.
  const titled = { ...BARS, id: "c2", source: ADS, title: "From the file" };
  const overAds = { ...BARS, id: "c3", source: ADS };
  const readable = [BARS, SCATTER, DEVICES];
  const path = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "charted.uno");
  await writeFile(path, unoOf([...readable, titled, overAds]));
  await shell.openRef({ name: "charted.uno", path });
  // A short plot draws the line of the rest under its bars, the scatter samples,
  // and the pie labels its slices.
  const plot = document.querySelector<HTMLElement>(".chart-plot")!;
  Object.defineProperty(plot, "clientHeight", { value: holding(SHORT_ROWS) });
  shell.language.choose(baseLocale);
  const said = (): string =>
    [...document.querySelectorAll(".chart-said")].map((at) => at.textContent).join("");
  const labelled = (): boolean =>
    document.querySelectorAll(".chart-pie .chart-slice-label").length > 0;
  const drawn = (): boolean =>
    plot.querySelector(".chart-bars-line") !== null && said() !== "" && labelled();
  expect(await until(domPage(), drawn)).toBe(true);
  shell.language.choose(PSEUDO_LOCALE);
  await frame();
  const head = document.querySelector(".chart-title")?.textContent;
  expect(head).toBe(`${SALES} · ${madeTitle(BARS.plot)}`);
  expect(said()).toContain(PSEUDO_OPEN);
  // What each drawing says it shows is written once its tally completes, in the
  // language chosen by then, its values from the file apart.
  const summaries = (): string[] =>
    [...document.querySelectorAll(".chart-summary-said")]
      .map((at) => at.textContent ?? "")
      .filter((text) => text !== "");
  expect(await until(domPage(), () => summaries().length === readable.length)).toBe(true);
  expect(summaries().every((text) => text.includes(PSEUDO_OPEN))).toBe(true);
  expect(document.querySelector(".chart-summary .from-file")!.textContent).toMatch(/\S/);
  expect(english(".chart")).toEqual([]);
  // t turns the first plot into its table, whose words follow the language too.
  const first = document.querySelector<HTMLElement>(".chart")!;
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
  await frame();
  const header = document.querySelector(".chart-table thead th:last-child")?.textContent;
  expect(header).toBe(m.chart_table_rows());
  expect(header).toContain(PSEUDO_OPEN);
  expect(document.querySelectorAll(".chart-table tbody th .from-file").length).toBeGreaterThan(0);
  expect(english(".chart")).toEqual([]);
});

test("a chart over a missing source says so and offers Re-point in the language chosen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "missing.uno");
  await writeFile(path, unoOf([BARS], [], "/nowhere/sales-q3.csv"));
  await shell.openRef({ name: "missing.uno", path });
  const state = (): string => document.querySelector(".chart-state")?.textContent ?? "";
  expect(await until(domPage(), () => state() !== "")).toBe(true);
  const missing = m.chart_source_missing({ name: `${SALES}.csv` });
  expect(state()).toBe(`${missing}${m.action_repoint()}`);
  expect(english(".chart")).toEqual([]);
});

test("a chart's edit form, its armed × and what Ctrl+Z says on it are in the language chosen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "edited.uno");
  await writeFile(path, unoOf([BARS]));
  await shell.openRef({ name: "edited.uno", path });
  // The chart's tally completes before the test ends, so no draw outlives the page.
  const summary = (): string => document.querySelector(".chart-summary-said")?.textContent ?? "";
  expect(await until(domPage(), () => summary() !== "")).toBe(true);
  const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
  click(".chart .chart-edit");
  expect(await until(domPage(), () => document.querySelector(".chart-form") !== null)).toBe(true);
  expect([...english(".chart-form"), ...english(".chart")]).toEqual([]);
  const form = document.querySelector(".chart-form")!;
  form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const undo = { key: "z", ctrlKey: true, bubbles: true, cancelable: true };
  document.querySelector(".chart")!.dispatchEvent(new KeyboardEvent("keydown", undo));
  expect([message(), plain(message())]).toStrictEqual([m.chart_undo_hint(), ""]);
  click(".chart .chart-close");
  const title = madeTitle(BARS.plot);
  expect([message(), plain(message())]).toStrictEqual([m.chart_remove_armed({ title }), ""]);
});

test("what r says over a chart whose folder holds no new file is in the language chosen", async () => {
  const part = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "sales-q3-part-1.csv");
  await copyFile(join(dirname(FIXTURE), basename(part)), part);
  const parts = [{ ref: { name: basename(part), path: part } }];
  await shell.openRef({ name: SALES, parts, header: "first" });
  shell.insertChartHere();
  expect(await until(domPage(), () => document.querySelector(".chart-form") !== null)).toBe(true);
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  document.querySelector(".chart-form select")!.dispatchEvent(enter);
  // The chart's tally completes before the test ends, so no draw outlives the page.
  const summary = (): string => document.querySelector(".chart-summary-said")?.textContent ?? "";
  expect(await until(domPage(), () => summary() !== "")).toBe(true);
  const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
  document.querySelector(".chart")!.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
  const none = m.refresh_no_new_files({ name: SALES });
  expect(await until(domPage(), () => message() === none)).toBe(true);
  expect(plain(message())).toBe("");
});

test("a refresh with nothing to read again, and what r says over it, are in the language chosen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "uno-pseudo-")), "carried.uno");
  await writeFile(path, carriedUnoOf([BARS], new Uint8Array(await readFile(FIXTURE))));
  await shell.openRef({ name: "carried.uno", path });
  // The chart's tally completes before the test ends, so no draw outlives the page.
  const summary = (): string => document.querySelector(".chart-summary-said")?.textContent ?? "";
  expect(await until(domPage(), () => summary() !== "")).toBe(true);
  const hint = m.chart_refresh_carried({ name: basename(FIXTURE) });
  expect(document.querySelector(".chart-refresh")?.getAttribute("title")).toBe(hint);
  expect(english(".chart")).toEqual([]);
  const message = (): string => document.querySelector("#status-msg")?.textContent ?? "";
  document.querySelector(".chart")!.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
  expect([message(), plain(message())]).toStrictEqual([hint, ""]);

  const lost = join(dirname(path), "lost.uno");
  await writeFile(lost, partsUnoOf([BARS], [join(dirname(path), "sales-q3-part-1.csv")]));
  await shell.openRef({ name: "lost.uno", path: lost });
  expect(await until(domPage(), () => document.querySelector(".chart-state") !== null)).toBe(true);
  expect(english(".chart")).toEqual([]);
  document.querySelector(".chart")!.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
  const why = m.chart_refresh_lost({ name: SALES });
  expect([message(), plain(message())]).toStrictEqual([why, ""]);
});
