// The panel's three sections and its browsing, driven with no window.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import type { Peeked, SourceRef } from "@uno/grid/engine";
import type { Entry, Listing } from "@uno/grid/store";

import type { Connection, Listings, Open } from "../src/renderer/sources.ts";
import { Sources } from "../src/renderer/sources.ts";

const ACME: Connection = {
  name: "acme-exports",
  path: "s3://acme-exports",
  kind: "s3",
  where: "eu-west-1",
};
const DISK: Connection = { name: "~/exports", path: "/home/jo/exports", kind: "disk" };

const TABS: Open[] = [
  { id: "a", name: "ledger.csv" },
  { id: "b", name: "q3.csv" },
];

function folder(name: string, path: string): Entry {
  return { name, path, folder: true };
}

function file(name: string, path: string, bytes: number): Entry {
  return { name, path, folder: false, bytes, modified: new Date("2025-09-01T10:00:00Z") };
}

const PAGES: Record<string, Entry[]> = {
  "s3://acme-exports": [
    folder("2025", "s3://acme-exports/2025"),
    file("ledger.csv", "s3://acme-exports/ledger.csv", 4096),
  ],
  "s3://acme-exports/2025": [
    folder("q3", "s3://acme-exports/2025/q3"),
    file("jan.csv", "s3://acme-exports/2025/jan.csv", 64),
  ],
  "/home/jo/exports": [file("notes.csv", "/home/jo/exports/notes.csv", 12)],
  "s3://acme-exports/2025/q3": [
    folder("raw", "s3://acme-exports/2025/q3/raw"),
    file("jul.csv", "s3://acme-exports/2025/q3/jul.csv", 100),
    file("aug.tsv", "s3://acme-exports/2025/q3/aug.tsv", 200),
    file("report.pdf", "s3://acme-exports/2025/q3/report.pdf", 300),
    file("sep.CSV", "s3://acme-exports/2025/q3/sep.CSV", 400),
  ],
};

const Q3: Connection = { name: "q3", path: "s3://acme-exports/2025/q3", kind: "s3" };

/** What a peek of a file answers: its name as the one header, so a test can
 * tell whose front it is looking at. */
function front(ref: SourceRef): Peeked {
  return { label: "UTF-8 · delimiter ','", header: [ref.name], rows: [] };
}

/**
 * A place to browse that answers out of the pages above. Holding it makes the
 * asks pending until the test says which one is answered, which is the only
 * way to have two in flight at once on purpose. Peeks are held the same way,
 * by a switch of their own, so a listing can land while a peek waits.
 */
class Stand implements Listings {
  readonly asked: string[] = [];
  readonly peeks: string[] = [];
  hold = false;
  holdPeeks = false;
  private readonly held: { path: string; answer: () => void }[] = [];

  list(path: string): Promise<Listing> {
    this.asked.push(path);
    const listing: Listing = { entries: PAGES[path] ?? [] };
    if (!this.hold) return Promise.resolve(listing);
    return new Promise((resolve) => this.held.push({ path, answer: () => resolve(listing) }));
  }

  peek(ref: SourceRef): Promise<Peeked> {
    const path = "path" in ref ? ref.path : ref.name;
    this.peeks.push(path);
    const peeked = front(ref);
    if (!this.holdPeeks) return Promise.resolve(peeked);
    return new Promise((resolve) => this.held.push({ path, answer: () => resolve(peeked) }));
  }

  answer(path: string): void {
    const i = this.held.findIndex((h) => h.path === path);
    this.held.splice(i, 1)[0]!.answer();
  }
}

function names(entries: readonly Entry[]): string[] {
  return entries.map((e) => e.name);
}

test("the panel opens on the tabs, the connections, and a browser with nothing in it", () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK]);

  expect(panel.tabs.map((t) => t.name)).toEqual(["ledger.csv", "q3.csv"]);
  expect(panel.connections).toEqual([ACME, DISK]);
  expect(panel.entries).toEqual([]);
  expect(panel.crumb).toEqual([]);
  expect(panel.path).toBe("");
  expect(panel.place).toEqual({ section: "workspace", line: 0 });
});

test("opening a connection lists it, and the keys land on what came back", async () => {
  const stand = new Stand();
  let drawn = 0;
  const panel = new Sources(
    stand,
    () => TABS,
    [ACME, DISK],
    () => drawn++,
  );

  await panel.open(ACME);

  expect(stand.asked).toEqual(["s3://acme-exports"]);
  expect(names(panel.entries)).toEqual(["2025", "ledger.csv"]);
  expect(panel.crumb).toEqual([{ name: "acme-exports", path: "s3://acme-exports" }]);
  expect(panel.path).toBe("s3://acme-exports");
  expect(panel.place).toEqual({ section: "browser", line: 0 });
  expect(panel.reading).toBe(false);
  expect(drawn).toBeGreaterThan(0);
});

test("entering a folder lists it, and the crumb says where you are", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [ACME]);

  await panel.open(ACME);
  panel.move(1);
  await panel.enter(panel.entries[0]!);

  expect(stand.asked).toEqual(["s3://acme-exports", "s3://acme-exports/2025"]);
  expect(names(panel.entries)).toEqual(["q3", "jan.csv"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports", "2025"]);
  // The keys go back to the top, since the line they were on was a line of the
  // folder that has just been left.
  expect(panel.place).toEqual({ section: "browser", line: 0 });
});

test("a file is not somewhere to go, and entering one lists nothing", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [ACME]);

  await panel.open(ACME);
  await panel.enter(panel.entries[1]!);

  expect(stand.asked).toEqual(["s3://acme-exports"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports"]);
});

test("going back up shows the folder it came from, and stops at the connection", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [ACME]);

  await panel.open(ACME);
  await panel.enter(panel.entries[0]!);
  await panel.up();

  expect(names(panel.entries)).toEqual(["2025", "ledger.csv"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports"]);

  await panel.up();

  expect(stand.asked).toEqual(["s3://acme-exports", "s3://acme-exports/2025", "s3://acme-exports"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports"]);
});

test("a listing for a folder nobody is in any more is dropped", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [ACME]);

  await panel.open(ACME);
  stand.hold = true;

  // Into a folder and straight back out of it, with both asks in flight. The
  // one for the folder left behind is answered last, and must not land.
  const down = panel.enter(panel.entries[0]!);
  const back = panel.up();
  stand.answer("s3://acme-exports");
  stand.answer("s3://acme-exports/2025");
  await Promise.all([down, back]);

  expect(names(panel.entries)).toEqual(["2025", "ledger.csv"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports"]);
  expect(panel.reading).toBe(false);
});

test("a place that cannot be browsed says so rather than showing an empty folder", async () => {
  const refuses: Listings = {
    list: () => Promise.reject(new Error("no lister browses s3:// on this machine")),
    peek: () => Promise.reject(new Error("nothing to peek at")),
  };
  const panel = new Sources(refuses, () => TABS, [ACME]);

  await panel.open(ACME);

  expect(panel.entries).toEqual([]);
  expect(panel.trouble).toBe("no lister browses s3:// on this machine");
  expect(panel.reading).toBe(false);
});

test("moving down the last line of a section carries on into the next one", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [ACME, DISK]);
  await panel.open(DISK);
  panel.focus("workspace");

  const walked = [];
  for (let i = 0; i < 5; i++) {
    walked.push(panel.place);
    panel.move(1);
  }

  expect(walked).toEqual([
    { section: "workspace", line: 0 },
    { section: "workspace", line: 1 },
    { section: "connections", line: 0 },
    { section: "connections", line: 1 },
    { section: "browser", line: 0 },
  ]);

  // The last line of the last section is as far as it goes, and coming back up
  // walks the same lines the other way.
  panel.move(1);
  expect(panel.place).toEqual({ section: "browser", line: 0 });
  panel.move(-4);
  expect(panel.place).toEqual({ section: "workspace", line: 0 });
});

test("a section with no lines is stepped over, and the top of the panel holds", () => {
  const panel = new Sources(new Stand(), () => [], [ACME, DISK]);

  expect(panel.place).toEqual({ section: "workspace", line: 0 });
  panel.move(1);
  expect(panel.place).toEqual({ section: "connections", line: 0 });
  panel.move(-1);
  // Nothing is open, so there is no line above the first connection to reach.
  expect(panel.place).toEqual({ section: "connections", line: 0 });
});

test("the keys stay on a line that exists when a tab closes under them", () => {
  let tabs = TABS;
  const panel = new Sources(new Stand(), () => tabs, [ACME]);

  panel.focus("workspace", 1);
  tabs = [TABS[0]!];

  expect(panel.place).toEqual({ section: "workspace", line: 0 });
});

/** The entry on the page by that name, since a toggle takes the entry itself. */
function named(panel: Sources, name: string): Entry {
  const entry = panel.entries.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no ${name} on the page`);
  return entry;
}

test("more than one file can be selected, and picking one again lets it go", async () => {
  const panel = new Sources(new Stand(), () => TABS, [Q3]);
  await panel.open(Q3);

  await panel.toggle(named(panel, "jul.csv"));
  await panel.toggle(named(panel, "aug.tsv"));
  await panel.toggle(named(panel, "sep.CSV"));

  expect(names(panel.selected)).toEqual(["jul.csv", "aug.tsv", "sep.CSV"]);
  expect(panel.chosen(named(panel, "aug.tsv"))).toBe(true);

  await panel.toggle(named(panel, "aug.tsv"));

  expect(names(panel.selected)).toEqual(["jul.csv", "sep.CSV"]);
  expect(panel.chosen(named(panel, "aug.tsv"))).toBe(false);
});

test("a folder and a file nothing reads cannot be selected", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [Q3]);
  await panel.open(Q3);

  expect(panel.selectable(named(panel, "raw"))).toBe(false);
  expect(panel.selectable(named(panel, "report.pdf"))).toBe(false);
  expect(panel.selectable(named(panel, "jul.csv"))).toBe(true);

  await panel.toggle(named(panel, "raw"));
  await panel.toggle(named(panel, "report.pdf"));

  expect(panel.selected).toEqual([]);
  expect(panel.buttons).toEqual([]);
  expect(stand.peeks).toEqual([]);
});

test("the selected files come back in the order they are listed, not the order they were picked", async () => {
  const panel = new Sources(new Stand(), () => TABS, [Q3]);
  await panel.open(Q3);

  await panel.toggle(named(panel, "sep.CSV"));
  await panel.toggle(named(panel, "jul.csv"));
  await panel.toggle(named(panel, "aug.tsv"));

  expect(names(panel.selected)).toEqual(["jul.csv", "aug.tsv", "sep.CSV"]);
});

test("the buttons offer nothing, then one file, then each file or all of them as one", async () => {
  const panel = new Sources(new Stand(), () => TABS, [Q3]);
  await panel.open(Q3);

  expect(panel.buttons).toEqual([]);

  await panel.toggle(named(panel, "aug.tsv"));

  expect(panel.buttons).toEqual([
    {
      label: "Add 1",
      one: false,
      refs: [{ name: "aug.tsv", path: "s3://acme-exports/2025/q3/aug.tsv" }],
    },
  ]);

  await panel.toggle(named(panel, "sep.CSV"));
  await panel.toggle(named(panel, "jul.csv"));

  const refs = [
    { name: "jul.csv", path: "s3://acme-exports/2025/q3/jul.csv" },
    { name: "aug.tsv", path: "s3://acme-exports/2025/q3/aug.tsv" },
    { name: "sep.CSV", path: "s3://acme-exports/2025/q3/sep.CSV" },
  ];
  expect(panel.buttons).toEqual([
    { label: "Add 3", one: false, refs },
    { label: "Add as one", one: true, refs },
  ]);
});

test("one selected file is peeked at, and a second selected puts the peek away", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [Q3]);
  await panel.open(Q3);

  await panel.toggle(named(panel, "jul.csv"));

  expect(stand.peeks).toEqual(["s3://acme-exports/2025/q3/jul.csv"]);
  expect(panel.peeked?.header).toEqual(["jul.csv"]);
  expect(panel.peeking).toBe(false);

  await panel.toggle(named(panel, "aug.tsv"));

  // Two files have no one front to show, so nothing more is asked for.
  expect(stand.peeks).toEqual(["s3://acme-exports/2025/q3/jul.csv"]);
  expect(panel.peeked).toBeUndefined();
  expect(panel.peeking).toBe(false);
});

test("a peek of a file that is no longer the one selected is dropped", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [Q3]);
  await panel.open(Q3);
  stand.holdPeeks = true;

  // Pick one file, then swap it for the next, with both peeks in flight. The
  // first is answered last, and must not land under the second's name.
  const first = panel.toggle(named(panel, "jul.csv"));
  const off = panel.toggle(named(panel, "jul.csv"));
  const second = panel.toggle(named(panel, "aug.tsv"));
  expect(panel.peeking).toBe(true);

  stand.answer("s3://acme-exports/2025/q3/aug.tsv");
  stand.answer("s3://acme-exports/2025/q3/jul.csv");
  await Promise.all([first, off, second]);

  expect(names(panel.selected)).toEqual(["aug.tsv"]);
  expect(panel.peeked?.header).toEqual(["aug.tsv"]);
  expect(panel.peeking).toBe(false);
});

test("browsing somewhere else lets go of the selection and the peek on its way", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [Q3]);
  await panel.open(Q3);
  stand.holdPeeks = true;

  const peek = panel.toggle(named(panel, "jul.csv"));
  expect(panel.peeking).toBe(true);

  await panel.enter(named(panel, "raw"));

  expect(panel.selected).toEqual([]);
  expect(panel.buttons).toEqual([]);
  expect(panel.peeking).toBe(false);

  // The peek lands after the person has gone, and is not shown in the folder
  // they went to.
  stand.answer("s3://acme-exports/2025/q3/jul.csv");
  await peek;

  expect(panel.peeked).toBeUndefined();
  expect(panel.peeking).toBe(false);

  // Going back to where the file was does not bring its selection back.
  await panel.up();
  expect(panel.chosen(named(panel, "jul.csv"))).toBe(false);
});

// No DOM, and it has to stay that way: the panel is the part of the shell whose
// browsing is worth testing, and it is only testable at all while it can be
// built without a document.
test("the panel reaches for no document and no window", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/renderer/sources.ts", import.meta.url)),
    "utf8",
  );
  // The prose says "window" often enough; it is the code that has to be clean.
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  expect(code).not.toMatch(/\bdocument\b|\bwindow\b|\bHTML[A-Za-z]*Element\b/);
});
