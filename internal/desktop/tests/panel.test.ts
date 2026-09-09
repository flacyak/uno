// @vitest-environment happy-dom
//
// The panel's column over the panel's state: the filter box, the list that
// holds only the rows on screen, the keys that walk it the way the grid's are
// read, and the peek and buttons underneath. What `Sources` decides is tested
// in sources.test.ts; this is whether the view asks it and draws what it says.

import { beforeEach, expect, test } from "vite-plus/test";

import type { Peeked, SourceRef } from "@uno/grid/engine";
import type { Entry, Listing } from "@uno/grid/store";

import type { InputName } from "../src/renderer/input/index.ts";
import { Panel, rowAt, rowCount, rowOf, spans } from "../src/renderer/shell/panel.ts";
import type { Connection, Listings, Open } from "../src/renderer/sources.ts";
import { Sources } from "../src/renderer/sources.ts";

const BUCKET: Connection = { name: "acme-exports", path: "s3://acme-exports", kind: "s3" };
const DISK: Connection = { name: "~/exports", path: "/home/jo/exports", kind: "disk" };

const TABS: Open[] = [
  { id: "a", name: "ledger-2025.csv" },
  { id: "b", name: "google-ads.csv" },
  { id: "c", name: "Ledger-2024.csv" },
];

/** The list is told it is 600 pixels tall, twenty-five of its rows, since
 * happy-dom lays nothing out. */
const VIEWPORT = 600;
const ROW = 24;

function name(i: number): string {
  return `orders-${String(i).padStart(6, "0")}.csv`;
}

/** A prefix of `n` objects. */
function objects(n: number): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    name: name(i),
    path: `s3://acme-exports/${name(i)}`,
    folder: false,
    bytes: 2048,
  }));
}

const PEEKED: Peeked = {
  label: "UTF-8 · delimiter ','",
  header: ["date", "amount"],
  rows: [["2025-10-01", "12.00"]],
};

/**
 * A bucket that answers `entries` a page of `size` at a time, with the cursor
 * being where the next page starts, and counts the asks.
 */
class Bucket implements Listings {
  readonly asked: (string | undefined)[] = [];

  constructor(
    private readonly entries: Entry[],
    private readonly size = Infinity,
  ) {}

  list(_path: string, cursor?: string): Promise<Listing> {
    this.asked.push(cursor);
    const from = Number(cursor ?? 0);
    const to = from + this.size;
    return Promise.resolve({
      entries: this.entries.slice(from, to),
      next: to < this.entries.length ? String(to) : undefined,
    });
  }

  peek(_ref: SourceRef): Promise<Peeked> {
    return Promise.resolve(PEEKED);
  }
}

interface Drawn {
  panel: Panel;
  sources: Sources;
  bucket: Bucket;
  root: HTMLElement;
  list: HTMLElement;
  chosen: string[];
  added: { names: string[]; one: boolean }[];
  closed: () => number;
}

function draw(bucket = new Bucket([]), input: { name: InputName } = { name: "default" }): Drawn {
  document.body.innerHTML = `<aside id="panel" class="panel" hidden></aside>`;
  const root = document.querySelector<HTMLElement>("#panel")!;
  let panel: Panel | undefined;
  const sources = new Sources(
    bucket,
    () => TABS,
    [BUCKET, DISK],
    () => panel?.draw(),
  );
  const chosen: string[] = [];
  const added: { names: string[]; one: boolean }[] = [];
  let closed = 0;
  panel = new Panel(root, sources, () => input.name, {
    select: (id) => chosen.push(id),
    add: (refs, one) => added.push({ names: refs.map((r) => r.name), one }),
    closed: () => closed++,
  });
  const list = root.querySelector<HTMLElement>(".panel-list")!;
  Object.defineProperty(list, "clientHeight", { value: VIEWPORT });
  panel.show();
  return { panel, sources, bucket, root, list, chosen, added, closed: () => closed };
}

function press(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** settle lets the asks in flight land and the frame they asked for draw. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function lines(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>(".panel-row")].map(
    (r) => r.children[0]!.textContent ?? "",
  );
}

function row(root: HTMLElement, text: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(".panel-row")].find(
    (r) => r.children[0]!.textContent === text,
  );
}

function selected(root: HTMLElement): string {
  return root.querySelector(".panel-row.sel")?.children[0]?.textContent ?? "";
}

function filter(root: HTMLElement, text: string, how: "enter" | "button"): void {
  const input = root.querySelector<HTMLInputElement>(".panel-filter input")!;
  input.value = text;
  if (how === "button") root.querySelector<HTMLButtonElement>(".panel-filter button")!.click();
  else root.querySelector<HTMLFormElement>(".panel-filter")!.requestSubmit();
}

function buttons(root: HTMLElement): string[] {
  const foot = root.querySelector<HTMLElement>(".panel-foot")!;
  if (foot.hidden) return [];
  return [...foot.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

/** Open the bucket, which puts the keys on its first entry. */
async function browse(d: Drawn): Promise<void> {
  d.sources.focus("connections");
  press(d.list, "Enter");
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

// ------------------------------------------------------------- the column

test("the column is each section's title and its lines, or a note where it has none", () => {
  const laid = spans((s) => ({ workspace: 2, connections: 0, browser: 3 })[s]);

  expect(rowCount(laid)).toBe(3 + 2 + 4);
  expect([...Array(rowCount(laid)).keys()].map((i) => rowAt(laid, i))).toEqual([
    { t: "head", section: "workspace" },
    { t: "line", section: "workspace", line: 0 },
    { t: "line", section: "workspace", line: 1 },
    { t: "head", section: "connections" },
    { t: "note", section: "connections" },
    { t: "head", section: "browser" },
    { t: "line", section: "browser", line: 0 },
    { t: "line", section: "browser", line: 1 },
    { t: "line", section: "browser", line: 2 },
  ]);
  expect(rowOf(laid, { section: "browser", line: 2 })).toBe(8);
});

test("the three sections are drawn from what the panel holds, sizes and all", async () => {
  const d = draw(new Bucket(objects(2)));
  await browse(d);

  expect(lines(d.root)).toEqual([
    "In this workspace",
    "ledger-2025.csv",
    "google-ads.csv",
    "Ledger-2024.csv",
    "Connections",
    "acme-exports",
    "~/exports",
    "Browser",
    "orders-000000.csv",
    "orders-000001.csv",
  ]);
  expect(row(d.root, "orders-000000.csv")!.children[1]!.textContent).toBe("2.0 KB");
  expect(row(d.root, "Browser")!.children[1]!.textContent).toBe("acme-exports");
});

test("a 200,000-entry listing scrolls with fewer than 100 rows in the DOM", async () => {
  const d = draw(new Bucket(objects(200_000)));
  await browse(d);

  expect(d.root.querySelectorAll(".panel-row").length).toBeLessThan(100);
  expect(selected(d.root)).toBe("orders-000000.csv");

  for (let i = 0; i < 20; i++) press(d.list, "PageDown");
  expect(selected(d.root)).toBe(name(20 * 24));

  d.sources.focus("browser", 199_998);
  press(d.list, "ArrowDown");
  expect(selected(d.root)).toBe("orders-199999.csv");
  expect(d.root.querySelectorAll(".panel-row").length).toBeLessThan(100);
});

// ------------------------------------------------------------- the paging

test("the next page is asked for as the end of the folder scrolls into view, and not before", async () => {
  const d = draw(new Bucket(objects(2500), 1000));
  await browse(d);

  expect(d.bucket.asked).toEqual([undefined]);
  expect(d.sources.entries).toHaveLength(1000);

  // The last line of the page is the end of the list, and reaching it is the ask.
  d.sources.focus("browser", 998);
  press(d.list, "ArrowDown");
  await settle();
  expect(d.bucket.asked).toEqual([undefined, "1000"]);
  expect(d.sources.entries).toHaveLength(2000);

  // Scrolling to the end the mouse's way asks for the last.
  d.list.scrollTop = (8 + 2000) * ROW;
  d.list.dispatchEvent(new Event("scroll"));
  await settle();
  expect(d.bucket.asked).toEqual([undefined, "1000", "2000"]);
  expect(d.sources.entries).toHaveLength(2500);
  expect(d.sources.more).toBe(false);
});

// --------------------------------------------------------------- the keys

test("the arrows walk the column for everyone, and j and k only for vim's keys", () => {
  const input: { name: InputName } = { name: "default" };
  const d = draw(new Bucket([]), input);

  expect(selected(d.root)).toBe("ledger-2025.csv");
  press(d.list, "ArrowDown");
  expect(selected(d.root)).toBe("google-ads.csv");
  press(d.list, "j");
  expect(selected(d.root)).toBe("google-ads.csv");

  input.name = "vim-style";
  press(d.list, "j");
  press(d.list, "j");
  expect(selected(d.root)).toBe("acme-exports");
  press(d.list, "k");
  press(d.list, "ArrowUp");
  expect(selected(d.root)).toBe("google-ads.csv");
});

test("Enter shows a tab, browses a connection, and adds a file", async () => {
  const d = draw(new Bucket(objects(3)));

  press(d.list, "ArrowDown");
  press(d.list, "Enter");
  expect(d.chosen).toEqual(["b"]);

  await browse(d);
  expect(d.sources.path).toBe("s3://acme-exports");

  press(d.list, "ArrowDown");
  press(d.list, "Enter");
  expect(d.added).toEqual([{ names: ["orders-000001.csv"], one: false }]);
});

test("Backspace goes back up the folder it came down", async () => {
  const folder: Entry = { name: "2025", path: "s3://acme-exports/2025", folder: true };
  const d = draw(new Bucket([folder, ...objects(1)]));
  await browse(d);

  press(d.list, "Enter");
  await settle();
  expect(row(d.root, "Browser")!.children[1]!.textContent).toBe("acme-exports / 2025");

  press(d.list, "Backspace");
  await settle();
  expect(row(d.root, "Browser")!.children[1]!.textContent).toBe("acme-exports");
});

test("Esc closes the panel and says so, once", () => {
  const d = draw();

  press(d.list, "Escape");
  expect(d.root.hidden).toBe(true);
  expect(d.closed()).toBe(1);
  d.panel.hide();
  expect(d.closed()).toBe(1);
});

// ------------------------------------------------------------- the filter

test("Enter in the filter or its button searches, and hands the keys back to the list", () => {
  const d = draw();

  filter(d.root, "ledger", "enter");
  expect(lines(d.root)).toEqual([
    "In this workspace",
    "ledger-2025.csv",
    "Ledger-2024.csv",
    "Connections",
    'nothing matches "ledger"',
    "Browser",
    "choose a connection to browse it",
  ]);
  expect(document.activeElement).toBe(d.list);

  filter(d.root, "ads", "button");
  expect(lines(d.root).slice(0, 2)).toEqual(["In this workspace", "google-ads.csv"]);
  expect(selected(d.root)).toBe("google-ads.csv");
});

test("typing in the filter moves nothing until it is asked for, and / is the way there", () => {
  const d = draw();
  const input = d.root.querySelector<HTMLInputElement>(".panel-filter input")!;

  press(d.list, "/");
  expect(document.activeElement).toBe(input);
  input.value = "ads";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  press(input, "j");

  expect(d.sources.filter).toBe("");
  expect(lines(d.root)).toContain("ledger-2025.csv");

  press(input, "Escape");
  expect(document.activeElement).toBe(d.list);
});

test("an S3 address searched for is added, and the box is emptied for the next", () => {
  const d = draw();
  const input = d.root.querySelector<HTMLInputElement>(".panel-filter input")!;

  filter(d.root, "s3://acme-exports/2025/q3/Google Ads.csv", "enter");

  expect(d.added).toEqual([{ names: ["Google Ads.csv"], one: false }]);
  expect(input.value).toBe("");
  expect(lines(d.root)).toContain("ledger-2025.csv");
});

// ------------------------------------------- the selection, peek and buttons

test("Space picks files, marks them, peeks at one, and the buttons add them", async () => {
  const pdf: Entry = { name: "summary.pdf", path: "s3://acme-exports/summary.pdf", folder: false };
  const d = draw(new Bucket([...objects(3), pdf]));
  await browse(d);

  expect(row(d.root, "summary.pdf")!.classList.contains("off")).toBe(true);
  expect(buttons(d.root)).toEqual([]);

  press(d.list, " ");
  await settle();
  expect(row(d.root, "orders-000000.csv")!.classList.contains("picked")).toBe(true);
  expect(buttons(d.root)).toEqual(["Add 1"]);
  const peek = d.root.querySelector<HTMLElement>(".panel-peek")!;
  expect(peek.hidden).toBe(false);
  expect([...peek.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["date", "amount"]);

  press(d.list, "ArrowDown");
  press(d.list, "ArrowDown");
  press(d.list, " ");
  await settle();
  expect(buttons(d.root)).toEqual(["Add 2", "Add as one"]);
  expect(peek.hidden).toBe(true);

  // Space on a file nothing reads leaves the selection as it was.
  press(d.list, "ArrowDown");
  press(d.list, " ");
  await settle();
  expect(buttons(d.root)).toEqual(["Add 2", "Add as one"]);

  const [each, one] = d.root.querySelectorAll<HTMLButtonElement>(".panel-foot button");
  one!.click();
  each!.click();
  expect(d.added).toEqual([
    { names: ["orders-000000.csv", "orders-000002.csv"], one: true },
    { names: ["orders-000000.csv", "orders-000002.csv"], one: false },
  ]);

  // Enter on a file with others picked adds what is picked, not the line.
  press(d.list, "ArrowUp");
  press(d.list, "ArrowUp");
  press(d.list, "Enter");
  expect(d.added[2]).toEqual({ names: ["orders-000000.csv", "orders-000002.csv"], one: false });
});

test("Enter on a file nothing reads adds nothing", async () => {
  const pdf: Entry = { name: "summary.pdf", path: "s3://acme-exports/summary.pdf", folder: false };
  const d = draw(new Bucket([pdf]));
  await browse(d);

  press(d.list, "Enter");
  expect(d.added).toEqual([]);
});
