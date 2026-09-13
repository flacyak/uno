// The panel's three sections and its browsing, driven with no window.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";

import type { Peeked, SourceRef } from "@uno/grid/engine";
import type { Entry, Listing } from "@uno/grid/store";

import type { Arriving, Connection, Listings, Open } from "../src/renderer/sources.ts";
import { Sources, joinedName, stateOf, trailTo } from "../src/renderer/sources.ts";

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

// A prefix as the S3 lister names it, with its trailing slash, which is where
// re-pointing a tab whose object was in it starts.
PAGES["s3://acme-exports/ads/"] = [
  file("ads-2025-10.csv", "s3://acme-exports/ads/ads-2025-10.csv", 512),
  file("ads-2025-11.csv", "s3://acme-exports/ads/ads-2025-11.csv", 640),
  file("notes.pdf", "s3://acme-exports/ads/notes.pdf", 80),
];

const Q3: Connection = { name: "q3", path: "s3://acme-exports/2025/q3", kind: "s3" };

/**
 * A prefix too big for one listing, as the lister pages it: each page is one
 * list, and the cursor that asks for the next is its index.
 */
const BOOKS: Record<string, Entry[][]> = {
  "s3://acme-exports/big": [
    [
      folder("archive", "s3://acme-exports/big/archive"),
      file("a.csv", "s3://acme-exports/big/a.csv", 1),
      file("b.csv", "s3://acme-exports/big/b.csv", 2),
    ],
    [
      file("c.csv", "s3://acme-exports/big/c.csv", 3),
      file("d.tsv", "s3://acme-exports/big/d.tsv", 4),
    ],
    [file("e.csv", "s3://acme-exports/big/e.csv", 5)],
  ],
};

const BIG: Connection = { name: "big", path: "s3://acme-exports/big", kind: "s3" };

/** What a peek of a file answers: its name as the one header, so a test can
 * tell whose front it is looking at. */
function front(ref: SourceRef): Peeked {
  return { label: { t: "read", delimiter: ",", header: "first" }, header: [ref.name], rows: [] };
}

/**
 * A place to browse that answers out of the pages above. Holding it makes the
 * asks pending until the test says which one is answered, which is the only
 * way to have two in flight at once on purpose. Peeks are held the same way,
 * by a switch of their own, so a listing can land while a peek waits.
 *
 * A later page is asked for, held and answered as `path@cursor`, so a test can
 * tell it from the first page of the same folder. Setting `refuse` makes every
 * listing asked for after it a refusal with that message.
 */
class Stand implements Listings {
  readonly asked: string[] = [];
  readonly peeks: string[] = [];
  hold = false;
  holdPeeks = false;
  refuse = "";
  private readonly held: { path: string; answer: () => void }[] = [];

  list(path: string, cursor?: string): Promise<Listing> {
    const key = cursor === undefined ? path : `${path}@${cursor}`;
    this.asked.push(key);
    const refused = this.refuse;
    const listing = this.page(path, cursor);
    const settle = (resolve: (l: Listing) => void, reject: (e: Error) => void) =>
      refused === "" ? resolve(listing) : reject(new Error(refused));
    if (!this.hold) return new Promise(settle);
    return new Promise((resolve, reject) =>
      this.held.push({ path: key, answer: () => settle(resolve, reject) }),
    );
  }

  private page(path: string, cursor?: string): Listing {
    const book = BOOKS[path];
    if (book === undefined) return { entries: PAGES[path] ?? [] };
    const i = cursor === undefined ? 0 : Number(cursor);
    return { entries: book[i]!, next: i + 1 < book.length ? String(i + 1) : undefined };
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
  for (let i = 0; i < 6; i++) {
    walked.push(panel.place);
    panel.move(1);
  }

  // The connections end on the line that connects another, which the keys
  // land on like any other.
  expect(walked).toEqual([
    { section: "workspace", line: 0 },
    { section: "workspace", line: 1 },
    { section: "connections", line: 0 },
    { section: "connections", line: 1 },
    { section: "connections", line: 2 },
    { section: "browser", line: 0 },
  ]);
  expect(panel.isConnect(2)).toBe(true);

  // The last line of the last section is as far as it goes, and coming back up
  // walks the same lines the other way.
  panel.move(1);
  expect(panel.place).toEqual({ section: "browser", line: 0 });
  panel.move(-5);
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

test("a source still opening is a workspace line after the tabs, until it has opened", () => {
  let arriving: readonly Arriving[] = [{ name: "orders-2025.csv" }, { name: "ads-q4.csv" }];
  const panel = new Sources(
    new Stand(),
    () => TABS,
    [ACME],
    () => {},
    () => arriving,
  );

  expect(panel.opening.map((a) => a.name)).toEqual(["orders-2025.csv", "ads-q4.csv"]);
  expect(panel.count("workspace")).toBe(TABS.length + 2);

  // The keys can rest on its line, and nothing is offered there: it is no tab yet.
  panel.focus("workspace", TABS.length);
  expect(panel.place).toEqual({ section: "workspace", line: TABS.length });
  expect(panel.doings).toEqual([]);

  // A filter keeps the ones it matches, as it does the tabs.
  panel.search("q4");
  expect(panel.opening.map((a) => a.name)).toEqual(["ads-q4.csv"]);
  panel.search("");
  panel.focus("workspace", TABS.length);

  // Opened, its line is gone and the keys are back on a line that exists.
  arriving = [];
  expect(panel.count("workspace")).toBe(TABS.length);
  expect(panel.place).toEqual({ section: "workspace", line: TABS.length - 1 });
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
  // As one they are one ref of all three in that order, named after the
  // folder, since their names share nothing.
  expect(panel.buttons).toEqual([
    { label: "Add 3", one: false, refs },
    {
      label: "Add as one",
      one: true,
      refs: [{ name: "q3.csv", parts: refs.map((ref) => ({ ref })), header: "first" }],
    },
  ]);
});

test("files added as one are named for what their names share, back to a whole word", () => {
  const at = (...names: string[]) =>
    names.map((name) => ({ name, path: `s3://acme-exports/shop/2025/${name}` }));

  expect(joinedName(at("orders-2025-01.csv", "orders-2025-02.csv"))).toBe("orders-2025.csv");
  expect(joinedName(at("sales-q3-part-1.csv", "sales-q3-part-2.csv"))).toBe("sales-q3-part.csv");
  expect(joinedName(at("ads-q3.csv", "ads-q4.csv"))).toBe("ads.csv");
  // One name that is the start of the other ends on a whole word already.
  expect(joinedName(at("sales.tsv", "sales_eu.tsv"))).toBe("sales.tsv");
  // Nothing shared but a letter is nothing shared: the folder names them.
  expect(joinedName(at("jan.csv", "jul.csv"))).toBe("2025.csv");
  expect(joinedName([{ name: "jan.csv", path: "/home/jo/exports/jan.csv" }])).toBe("jan.csv");
  expect(
    joinedName([
      { name: "a.csv", path: "/home/jo/exports/a.csv" },
      { name: "b.csv", path: "/home/jo/exports/b.csv" },
    ]),
  ).toBe("exports.csv");
  // With no folder to be named after, the first file names them.
  expect(
    joinedName([
      { name: "a.csv", path: "a.csv" },
      { name: "b.csv", path: "b.csv" },
    ]),
  ).toBe("a.csv");
});

test("how files are read as one is chosen while Add as one is offered, and kept", async () => {
  let drawn = 0;
  const panel = new Sources(
    new Stand(),
    () => TABS,
    [Q3],
    () => drawn++,
  );
  await panel.open(Q3);
  const one = () => panel.buttons.find((b) => b.one)?.refs[0];

  await panel.toggle(named(panel, "jul.csv"));
  expect(panel.joining).toBeUndefined();

  await panel.toggle(named(panel, "sep.CSV"));
  expect(panel.joining).toEqual({ header: "first", fileColumn: false });
  expect(one()).toMatchObject({ header: "first" });
  expect(one()).not.toHaveProperty("fileColumn");

  const before = drawn;
  panel.join({ header: "none" });
  panel.join({ fileColumn: true });
  expect(drawn).toBe(before + 2);
  expect(panel.joining).toEqual({ header: "none", fileColumn: true });
  expect(one()).toMatchObject({ header: "none", fileColumn: true });

  // Somewhere else, with other files picked, the choices are as they were left.
  await panel.open(BIG);
  expect(panel.joining).toBeUndefined();
  await panel.toggle(named(panel, "a.csv"));
  await panel.toggle(named(panel, "b.csv"));
  expect(panel.joining).toEqual({ header: "none", fileColumn: true });

  // A tab reads one file, so picking for one offers no way to read several.
  await panel.repoint(TABS[0]!);
  expect(panel.joining).toBeUndefined();
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

test("a search narrows every section to the lines whose names hold it", async () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK, Q3]);
  await panel.open(Q3);

  panel.search("q3");

  expect(panel.filter).toBe("q3");
  expect(panel.tabs.map((t) => t.id)).toEqual(["b"]);
  expect(panel.connections).toEqual([Q3]);
  expect(names(panel.entries)).toEqual([]);

  panel.search("jul");

  expect(panel.tabs).toEqual([]);
  expect(panel.connections).toEqual([]);
  expect(names(panel.entries)).toEqual(["jul.csv"]);
  expect(panel.count("browser")).toBe(1);
});

test("a search ignores case, in what is typed and in the names it is held to", async () => {
  const panel = new Sources(new Stand(), () => TABS, [Q3]);
  await panel.open(Q3);

  panel.search("  CSV ");

  expect(panel.filter).toBe("csv");
  expect(panel.tabs).toHaveLength(2);
  expect(names(panel.entries)).toEqual(["jul.csv", "sep.CSV"]);
});

test("a connection is kept on its path as well as its name", () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK]);

  panel.search("/home/jo");

  expect(panel.connections).toEqual([DISK]);
});

test("an empty search shows every line again", async () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK, Q3]);
  await panel.open(Q3);
  panel.search("jul");

  panel.search("   ");

  expect(panel.filter).toBe("");
  expect(panel.tabs).toBe(TABS);
  expect(panel.connections).toEqual([ACME, DISK, Q3]);
  expect(panel.entries).toHaveLength(5);
});

test("a search puts the keys on the first line it leaves, whichever section that is in", async () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK, Q3]);
  await panel.open(Q3);

  panel.search("q3");
  expect(panel.place).toEqual({ section: "workspace", line: 0 });

  panel.search("exports");
  expect(panel.place).toEqual({ section: "connections", line: 0 });

  panel.search("aug");
  expect(panel.place).toEqual({ section: "browser", line: 0 });
});

test("a file the filter hides stays selected, and is still handed to the buttons", async () => {
  const panel = new Sources(new Stand(), () => TABS, [Q3]);
  await panel.open(Q3);
  await panel.toggle(named(panel, "jul.csv"));
  await panel.toggle(named(panel, "aug.tsv"));

  panel.search("aug");

  expect(names(panel.entries)).toEqual(["aug.tsv"]);
  expect(names(panel.selected)).toEqual(["jul.csv", "aug.tsv"]);
  expect(panel.buttons[0]!.refs.map((r) => r.name)).toEqual(["jul.csv", "aug.tsv"]);

  panel.search("");
  expect(panel.chosen(named(panel, "jul.csv"))).toBe(true);
});

test("a page that lands while a search is on is filtered afresh, not served from the last page", async () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, Q3]);
  await panel.open(Q3);
  panel.search("csv");
  expect(names(panel.entries)).toEqual(["jul.csv", "sep.CSV"]);

  await panel.open(ACME);

  expect(panel.filter).toBe("csv");
  expect(names(panel.entries)).toEqual(["ledger.csv"]);
});

test("a pasted s3:// object is offered to add, and filters nothing out", async () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, Q3]);
  await panel.open(Q3);

  panel.search("  s3://acme-exports/2025/Q4/Orders.csv ");

  expect(panel.pasted).toEqual({
    name: "Orders.csv",
    path: "s3://acme-exports/2025/Q4/Orders.csv",
  });
  expect(panel.filter).toBe("");
  expect(panel.tabs).toHaveLength(2);
  expect(panel.connections).toHaveLength(2);
  expect(panel.entries).toHaveLength(5);

  panel.search("jul");
  expect(panel.pasted).toBeUndefined();
});

test("an object's https address is offered as its s3:// form", () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME]);

  panel.search("https://acme-exports.s3.eu-west-1.amazonaws.com/2025/q3/Google%20Ads.csv");

  expect(panel.pasted).toEqual({
    name: "Google Ads.csv",
    path: "s3://acme-exports/2025/q3/Google Ads.csv",
  });
  expect(panel.filter).toBe("");
  expect(panel.connections).toEqual([ACME]);
});

test("an address with no object in it is only a filter", () => {
  const panel = new Sources(new Stand(), () => TABS, [ACME, DISK]);

  for (const typed of [
    "s3://acme-exports",
    "s3://acme-exports/2025/",
    "https://example.com/a.csv",
  ]) {
    panel.search(typed);
    expect(panel.pasted, typed).toBeUndefined();
    expect(panel.filter, typed).toBe(typed.toLowerCase());
  }

  panel.search("s3://acme-exports");
  expect(panel.connections).toEqual([ACME]);
});

test("an address the URL parser chokes on is a filter, not a throw", () => {
  // A bare per cent is a stray escape, and decoding a path that holds one
  // raises a URIError rather than returning anything. The filter is where an
  // address is pasted now, so a typo like this reaches the check before
  // anything else, and a search that threw would leave the box doing nothing.
  const panel = new Sources(new Stand(), () => TABS, [ACME]);

  for (const typed of [
    "https://example.com/100%.csv",
    "https://s3.eu-west-1.amazonaws.com/acme/50%off.csv",
    "https://acme-exports.s3.amazonaws.com/50%off.csv",
    "https://s3.amazonaws.com/100%/ledger.csv",
  ]) {
    expect(() => panel.search(typed), typed).not.toThrow();
    expect(panel.pasted, typed).toBeUndefined();
    expect(panel.filter, typed).toBe(typed.toLowerCase());
  }
});

test("the pages of a big folder are added to it in order, each once, until the last", async () => {
  const stand = new Stand();
  let drawn = 0;
  const panel = new Sources(
    stand,
    () => TABS,
    [BIG],
    () => drawn++,
  );
  await panel.open(BIG);

  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv"]);
  expect(panel.more).toBe(true);

  const before = drawn;
  await panel.next();
  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv", "c.csv", "d.tsv"]);
  expect(panel.more).toBe(true);
  expect(drawn).toBeGreaterThan(before);

  await panel.next();
  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv", "c.csv", "d.tsv", "e.csv"]);
  expect(panel.more).toBe(false);
  expect(panel.count("browser")).toBe(6);
  expect(stand.asked).toEqual([
    "s3://acme-exports/big",
    "s3://acme-exports/big@1",
    "s3://acme-exports/big@2",
  ]);
});

test("asking for more at the end of a folder sends nothing", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [Q3]);
  await panel.open(Q3);

  expect(panel.more).toBe(false);
  await panel.next();
  await panel.next();

  expect(stand.asked).toEqual(["s3://acme-exports/2025/q3"]);
  expect(panel.entries).toHaveLength(5);
});

test("asking for more before anything is browsed, or while the first page is coming, sends nothing", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [BIG]);

  await panel.next();
  expect(stand.asked).toEqual([]);

  stand.hold = true;
  const first = panel.open(BIG);
  await panel.next();
  expect(stand.asked).toEqual(["s3://acme-exports/big"]);
  stand.answer("s3://acme-exports/big");
  await first;
});

test("many asks for more while a page is on its way send one request", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [BIG]);
  await panel.open(BIG);
  stand.hold = true;

  // A scroll near the end of the list fires many times before a page lands.
  const asks = [panel.next(), panel.next(), panel.next()];
  expect(stand.asked).toEqual(["s3://acme-exports/big", "s3://acme-exports/big@1"]);
  expect(panel.reading).toBe(false);

  stand.answer("s3://acme-exports/big@1");
  await Promise.all(asks);

  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv", "c.csv", "d.tsv"]);
});

test("a later page for a folder nobody is in any more is not added to the one they are in", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [BIG]);
  await panel.open(BIG);
  stand.hold = true;

  const more = panel.next();
  const into = panel.enter(named(panel, "archive"));
  stand.answer("s3://acme-exports/big/archive");
  await into;
  stand.answer("s3://acme-exports/big@1");
  await more;

  expect(panel.path).toBe("s3://acme-exports/big/archive");
  expect(panel.entries).toEqual([]);
  expect(panel.more).toBe(false);
});

test("browsing starts every folder from its first page, whatever was paged before", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [BIG, Q3]);
  await panel.open(BIG);
  await panel.next();

  await panel.open(Q3);
  expect(panel.more).toBe(false);

  // Back to the big folder: its first page again, and the cursor is the one it
  // hands back rather than wherever paging had got to last time.
  await panel.open(BIG);
  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv"]);
  await panel.next();

  expect(stand.asked).toEqual([
    "s3://acme-exports/big",
    "s3://acme-exports/big@1",
    "s3://acme-exports/2025/q3",
    "s3://acme-exports/big",
    "s3://acme-exports/big@1",
  ]);
});

test("the selection and the keys stay where they were when a page lands", async () => {
  const panel = new Sources(new Stand(), () => TABS, [BIG]);
  await panel.open(BIG);
  await panel.toggle(named(panel, "b.csv"));
  panel.focus("browser", 2);

  await panel.next();

  expect(panel.place).toEqual({ section: "browser", line: 2 });
  expect(panel.entries[panel.place.line]!.name).toBe("b.csv");
  expect(names(panel.selected)).toEqual(["b.csv"]);
  expect(panel.peeked?.header).toEqual(["b.csv"]);

  // A file from the new page can join it, and they come back in listing order.
  await panel.toggle(named(panel, "c.csv"));
  expect(names(panel.selected)).toEqual(["b.csv", "c.csv"]);
});

test("a search on while a page lands sees the new entries, not what it kept before", async () => {
  const panel = new Sources(new Stand(), () => TABS, [BIG]);
  await panel.open(BIG);
  panel.search("csv");
  const before = panel.entries;
  expect(names(before)).toEqual(["a.csv", "b.csv"]);

  await panel.next();

  expect(names(panel.entries)).toEqual(["a.csv", "b.csv", "c.csv"]);
  // The page before is left as it was, since something may still be drawing it.
  expect(names(before)).toEqual(["a.csv", "b.csv"]);
});

test("a later page that fails keeps what was shown, and the next ask tries it again", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => TABS, [BIG]);
  await panel.open(BIG);

  stand.refuse = "the credentials for acme-exports have expired";
  await panel.next();

  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv"]);
  expect(panel.trouble).toBe("the credentials for acme-exports have expired");
  expect(panel.more).toBe(true);
  expect(panel.reading).toBe(false);

  stand.refuse = "";
  await panel.next();

  expect(names(panel.entries)).toEqual(["archive", "a.csv", "b.csv", "c.csv", "d.tsv"]);
  expect(panel.trouble).toBe("");
  expect(stand.asked).toEqual([
    "s3://acme-exports/big",
    "s3://acme-exports/big@1",
    "s3://acme-exports/big@1",
  ]);
});

// No DOM, and it has to stay that way: the panel is the part of the shell whose
// browsing is worth testing, and it is only testable at all while it can be
// built without a document.
// ------------------------------------------------------------ in this workspace

/** Three tabs: one that reads, one whose object is gone, one whose file changed. */
const STATED: Open[] = [
  { id: "a", name: "ledger.csv", link: { path: "/home/jo/exports/ledger.csv" }, bytes: 4096 },
  {
    id: "b",
    name: "ads.csv",
    link: {
      path: "s3://acme-exports/ads/ads.csv",
      missing: { t: "text", text: "ads.csv is not there" },
    },
  },
  {
    id: "c",
    name: "q3.csv",
    link: {
      path: "/home/jo/exports/q3.csv",
      changed: { t: "text", text: "q3.csv is 12 bytes bigger" },
    },
    bytes: 12,
  },
];

test("each tab's line says whether its file reads, changed, or is missing", () => {
  expect(STATED.map(stateOf)).toEqual(["fine", "missing", "changed"]);
  // A tab carried in the workspace has no file to have gone wrong.
  expect(stateOf({ id: "d", name: "carried.csv" })).toBe("fine");
});

test("the keys on a tab offer reload, re-point and remove, and nothing elsewhere", async () => {
  const panel = new Sources(new Stand(), () => STATED, [ACME]);

  panel.focus("workspace", 1);
  expect(panel.doings).toEqual([
    { label: "Reload", does: "reload", id: "b" },
    { label: "Re-point", does: "repoint", id: "b" },
    { label: "Remove", does: "remove", id: "b" },
  ]);

  panel.focus("connections");
  expect(panel.doings).toEqual([]);
});

// ------------------------------------------------------------ a folder that grew

/** A tab reading `names` out of a folder as one. */
function joined(folder: string, ...names: string[]): Open {
  return {
    id: "m",
    name: "joined.csv",
    parts: names.map((name) => ({ name, path: `${folder}${name}` })),
  };
}

test("a tab of several files is offered the files after its last that its folder has gained", async () => {
  const stand = new Stand();
  const tab = joined("s3://acme-exports/ads/", "ads-2025-10.csv");
  let drawn = 0;
  const panel = new Sources(
    stand,
    () => [...TABS, tab],
    [ACME],
    () => drawn++,
  );

  // Nothing is offered that nobody has asked about.
  expect(panel.grown(tab)).toBeUndefined();

  await panel.askGrown();

  // Only the folder of a tab with parts is listed, as the lister names it.
  expect(stand.asked).toEqual(["s3://acme-exports/ads/"]);
  expect(drawn).toBe(1);
  // The PDF sorts after it too, and is not a file a part can be.
  const files = [{ name: "ads-2025-11.csv", path: "s3://acme-exports/ads/ads-2025-11.csv" }];
  expect(panel.grown(tab)).toEqual({ folder: "ads/", files });
  expect(panel.grown(TABS[0]!)).toBeUndefined();

  // The offer is the first thing its line has, and it is not re-pointed.
  panel.focus("workspace", 2);
  expect(panel.doings).toEqual([
    { label: "1 new file in ads/ · append", does: "append", id: "m", files },
    { label: "Remove", does: "remove", id: "m" },
  ]);
});

test("a folder that has gained a file lists it under the offer, and keeps what was picked", async () => {
  const stand = new Stand();
  const at = "s3://acme-exports/ads/";
  const tab = joined(at, "ads-2025-10.csv", "ads-2025-11.csv");
  const panel = new Sources(stand, () => [tab], [{ name: "ads", path: at, kind: "s3" }]);
  await panel.open(panel.connections[0]!);
  await panel.toggle(named(panel, "ads-2025-11.csv"));
  const had = PAGES[at]!;

  try {
    PAGES[at] = [...had.slice(0, 2), file("ads-2025-12.csv", `${at}ads-2025-12.csv`, 700), had[2]!];
    await panel.askGrown();

    expect(panel.grown(tab)?.files.map((f) => f.name)).toEqual(["ads-2025-12.csv"]);
    expect(names(panel.entries)).toEqual(names(PAGES[at]!));
    expect(names(panel.selected)).toEqual(["ads-2025-11.csv"]);
    expect(panel.reading).toBe(false);
  } finally {
    PAGES[at] = had;
  }
});

test("a file that sorts before the last part is not offered, wherever it came from", async () => {
  const tab = joined("s3://acme-exports/ads/", "ads-2025-11.csv");
  const panel = new Sources(new Stand(), () => [tab], [ACME]);

  await panel.askGrown();

  // ads-2025-10.csv is in the folder and is not a part, and appending it
  // would not be reading the folder in order.
  expect(panel.grown(tab)).toBeUndefined();
  expect(panel.doings).toEqual([]);
});

test("every page of the folder is read for what it has gained", async () => {
  const stand = new Stand();
  const tab = joined("s3://acme-exports/big/", "a.csv", "b.csv");
  BOOKS["s3://acme-exports/big/"] = BOOKS["s3://acme-exports/big"]!;
  const panel = new Sources(stand, () => [tab], [BIG]);

  await panel.askGrown();

  expect(stand.asked).toEqual([
    "s3://acme-exports/big/",
    "s3://acme-exports/big/@1",
    "s3://acme-exports/big/@2",
  ]);
  expect(panel.grown(tab)?.files.map((f) => f.name)).toEqual(["c.csv", "d.tsv", "e.csv"]);
  expect(panel.doings[0]?.label).toBe("3 new files in big/ · append");
});

test("what a folder gained is not offered to a tab that has been appended to since", async () => {
  let tab = joined("s3://acme-exports/ads/", "ads-2025-10.csv");
  const panel = new Sources(new Stand(), () => [tab], [ACME]);
  await panel.askGrown();
  expect(panel.grown(tab)).toBeDefined();

  // The append lands before anything is asked again: the answer in hand is
  // about a list of parts the tab no longer has.
  tab = joined("s3://acme-exports/ads/", "ads-2025-10.csv", "ads-2025-11.csv");
  expect(panel.grown(tab)).toBeUndefined();

  await panel.askGrown();
  expect(panel.grown(tab)).toBeUndefined();
});

test("a folder that cannot be listed offers nothing, and a tab on a disk is asked by its folder", async () => {
  const stand = new Stand();
  const tab = joined("/home/jo/exports/", "a.csv", "b.csv");
  PAGES["/home/jo/exports"] = [
    file("b.csv", "/home/jo/exports/b.csv", 2),
    file("c.csv", "/home/jo/exports/c.csv", 3),
    file("notes.csv", "/home/jo/exports/notes.csv", 12),
  ];
  const panel = new Sources(stand, () => [tab]);

  await panel.askGrown();
  expect(stand.asked).toEqual(["/home/jo/exports"]);
  expect(panel.grown(tab)).toEqual({
    folder: "exports/",
    files: [
      { name: "c.csv", path: "/home/jo/exports/c.csv" },
      { name: "notes.csv", path: "/home/jo/exports/notes.csv" },
    ],
  });

  stand.refuse = "/home/jo/exports: no such folder";
  await panel.askGrown();
  expect(panel.grown(tab)).toBeUndefined();
});

test("a tab with no file has nothing to reload, and the last tab cannot be removed", () => {
  const carried: Open = { id: "d", name: "carried.csv" };
  const panel = new Sources(new Stand(), () => [carried]);

  expect(panel.doings).toEqual([{ label: "Re-point", does: "repoint", id: "d" }]);
});

test("the trail to an object starts at its bucket and keeps each prefix's slash", () => {
  expect(trailTo("s3://acme-exports/shop/2025/orders.csv")).toEqual([
    { name: "acme-exports", path: "s3://acme-exports" },
    { name: "shop", path: "s3://acme-exports/shop/" },
    { name: "2025", path: "s3://acme-exports/shop/2025/" },
  ]);
  expect(trailTo("s3://acme-exports/top.csv")).toEqual([
    { name: "acme-exports", path: "s3://acme-exports" },
  ]);
  expect(trailTo("/home/jo/exports/q3.csv")).toEqual([
    { name: "exports", path: "/home/jo/exports" },
  ]);
  expect(trailTo("C:\\exports\\q3.csv")).toEqual([{ name: "exports", path: "C:\\exports" }]);
  expect(trailTo("q3.csv")).toBeUndefined();
});

test("re-pointing a missing object browses the prefix it was in, with the keys there", async () => {
  const stand = new Stand();
  const panel = new Sources(stand, () => STATED, [ACME]);

  await panel.repoint(STATED[1]!);

  expect(panel.repointing?.id).toBe("b");
  expect(stand.asked).toEqual(["s3://acme-exports/ads/"]);
  expect(panel.crumb.map((c) => c.name)).toEqual(["acme-exports", "ads"]);
  expect(names(panel.entries)).toEqual(["ads-2025-10.csv", "ads-2025-11.csv", "notes.pdf"]);
  expect(panel.place).toEqual({ section: "browser", line: 0 });

  // Up goes as far as the bucket, as it would from the connection.
  await panel.up();
  expect(stand.asked).toEqual(["s3://acme-exports/ads/", "s3://acme-exports"]);
});

test("picking for a tab is one file, and the button points the tab at it", async () => {
  const panel = new Sources(new Stand(), () => STATED, [ACME]);
  await panel.repoint(STATED[1]!);

  await panel.toggle(named(panel, "ads-2025-10.csv"));
  await panel.toggle(named(panel, "ads-2025-11.csv"));

  expect(names(panel.selected)).toEqual(["ads-2025-11.csv"]);
  expect(panel.buttons).toEqual([
    {
      label: "Point ads.csv here",
      one: false,
      refs: [{ name: "ads-2025-11.csv", path: "s3://acme-exports/ads/ads-2025-11.csv" }],
      to: "b",
    },
  ]);

  // Picking it again lets it go, as it does when adding.
  await panel.toggle(named(panel, "ads-2025-11.csv"));
  expect(panel.buttons).toEqual([]);
});

test("stopping goes back to adding, and lets go of what was picked", async () => {
  const panel = new Sources(new Stand(), () => STATED, [ACME]);
  await panel.repoint(STATED[1]!);
  await panel.toggle(named(panel, "ads-2025-10.csv"));

  panel.stop();

  expect(panel.repointing).toBeUndefined();
  expect(panel.selected).toEqual([]);
  // The folder stays, so adding from it is one pick away.
  expect(names(panel.entries)).toEqual(["ads-2025-10.csv", "ads-2025-11.csv", "notes.pdf"]);

  await panel.toggle(named(panel, "ads-2025-10.csv"));
  await panel.toggle(named(panel, "ads-2025-11.csv"));
  expect(panel.buttons.map((b) => b.label)).toEqual(["Add 2", "Add as one"]);
});

test("a tab that closes while it is picked for is not picked for any more", async () => {
  let tabs = STATED;
  const panel = new Sources(new Stand(), () => tabs, [ACME]);
  await panel.repoint(STATED[1]!);
  await panel.toggle(named(panel, "ads-2025-10.csv"));

  tabs = [STATED[0]!, STATED[2]!];

  expect(panel.repointing).toBeUndefined();
  expect(panel.buttons.map((b) => b.label)).toEqual(["Add 1"]);
});

test("re-pointing a tab with no file to start from picks from where the browser is", async () => {
  const stand = new Stand();
  const carried: Open = { id: "d", name: "carried.csv" };
  const panel = new Sources(stand, () => [...TABS, carried], [Q3]);
  await panel.open(Q3);
  await panel.toggle(named(panel, "jul.csv"));
  await panel.toggle(named(panel, "aug.tsv"));

  await panel.repoint(carried);

  expect(stand.asked).toEqual(["s3://acme-exports/2025/q3"]);
  expect(panel.selected).toEqual([]);
  expect(panel.place.section).toBe("browser");
  expect(panel.repointing?.id).toBe("d");
});

test("the panel reaches for no document and no window", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/renderer/sources.ts", import.meta.url)),
    "utf8",
  );
  // The prose says "window" often enough; it is the code that has to be clean.
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  expect(code).not.toMatch(/\bdocument\b|\bwindow\b|\bHTML[A-Za-z]*Element\b/);
});

test("the selected files are read once per page and per pick, not once per draw", async () => {
  const panel = new Sources(new Stand(), () => TABS, [BIG]);
  await panel.open(BIG);
  await panel.toggle(named(panel, "a.csv"));

  // Every draw asks, through the buttons and the choices, and a page can be
  // 200,000 entries: the same page and the same picks are the same answer.
  const once = panel.selected;
  expect(names(once)).toEqual(["a.csv"]);
  expect(panel.selected).toBe(once);

  // A pick is a new answer, and so is a page that lands.
  await panel.toggle(named(panel, "b.csv"));
  const picked = panel.selected;
  expect(picked).not.toBe(once);
  expect(names(picked)).toEqual(["a.csv", "b.csv"]);
  expect(panel.selected).toBe(picked);

  await panel.next();
  await panel.toggle(named(panel, "c.csv"));
  expect(names(panel.selected)).toEqual(["a.csv", "b.csv", "c.csv"]);
});
