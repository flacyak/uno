// @vitest-environment happy-dom
//
// Connecting a bucket from the panel: the fields, the profile list the engine
// names, the test that lists the folder, and save.
//
// What is under test is that nothing is kept that did not work. A test that
// fails names what stopped it in the engine's own words -- a 403, a bucket
// that is not there, an SSO sign-in that has expired -- and a save that finds
// the same saves nothing. A save that works keeps the connection the test
// found, region and all, and the panel browses it.

import { beforeEach, expect, test } from "vite-plus/test";

import type { Peeked, Said, SourceRef } from "@uno/grid/engine";
import type { Connection } from "@uno/grid/library";
import type { Listing } from "@uno/grid/store";
import type { Tried } from "@uno/grid/store/s3";

import type { ConnectAsks } from "../src/renderer/shell/connect.ts";
import { draftOf, folderOf, triedLine } from "../src/renderer/shell/connect.ts";
import { Panel } from "../src/renderer/shell/panel.ts";
import type { Listings } from "../src/renderer/sources.ts";
import { Sources, stateOf } from "../src/renderer/sources.ts";

const REGION = "eu-west-1";

function connection(over: Partial<Connection> = {}): Connection {
  return {
    format: 1,
    id: "acme-exports",
    name: "acme-exports / shop",
    provider: "s3",
    bucket: "acme-exports",
    prefix: "shop/",
    auth: { mode: "profile", profile: "finance" },
    created: undefined,
    modified: undefined,
    ...over,
  };
}

// ------------------------------------------------------------ the draft

test("a prefix is kept as a folder however it was typed", () => {
  for (const typed of ["shop", "shop/", "/shop", " /shop// "])
    expect(folderOf(typed), typed).toBe("shop/");
  expect(folderOf("")).toBe("");
  expect(folderOf("/")).toBe("");
});

test("the fields are a connection named after its bucket and folder, signing in as chosen", () => {
  expect(
    draftOf({ bucket: " acme-exports ", prefix: "shop", signIn: "profile:finance" }, []),
  ).toEqual(connection());
  expect(draftOf({ bucket: "open-data", prefix: "", signIn: "public" }, []).auth).toEqual({
    mode: "public",
  });
  expect(draftOf({ bucket: "open-data", prefix: "", signIn: "machine" }, []).name).toBe(
    "open-data",
  );
});

// A second folder of one bucket is a second connection, in a second file. The
// same folder again is the one already kept, made again.
test("an id already kept for another folder is not taken; the same folder keeps its own", () => {
  const kept = [connection({ prefix: "refunds/", created: new Date("2026-09-01T00:00:00Z") })];
  expect(draftOf({ bucket: "acme-exports", prefix: "shop", signIn: "machine" }, kept).id).toBe(
    "acme-exports-2",
  );
  const again = draftOf({ bucket: "acme-exports", prefix: "refunds", signIn: "machine" }, kept);
  expect(again.id).toBe("acme-exports");
  expect(again.created).toEqual(kept[0]!.created);
});

test("a test that worked says what the folder held", () => {
  const tried: Tried = {
    connection: connection({ region: REGION }),
    folders: 3,
    files: 41,
    more: false,
  };
  expect(triedLine(tried)).toBe("listed shop/ · 3 folders, 41 files");
  expect(triedLine({ ...tried, folders: 1, files: 1, more: true })).toBe(
    "listed shop/ · 1 folder, 1 file, and more",
  );
  expect(triedLine({ ...tried, connection: connection({ prefix: "" }) })).toBe(
    "listed the bucket · 3 folders, 41 files",
  );
});

// ------------------------------------------------------------ the form

/** Nothing is browsed in these tests but the connection just saved. */
class Listed implements Listings {
  readonly asked: string[] = [];
  list(path: string): Promise<Listing> {
    this.asked.push(path);
    return Promise.resolve({
      entries: [{ name: "orders.csv", path: `${path}orders.csv`, folder: false }],
    });
  }
  peek(_ref: SourceRef): Promise<Peeked> {
    return Promise.reject(new Error("not peeked"));
  }
}

/** An engine and a host that answer the way the test says, and remember what they were asked. */
class Asks implements ConnectAsks {
  tried: Connection[] = [];
  saved: Connection[] = [];
  refusal: string | undefined;
  names = ["default", "finance"];
  kept: Connection[] = [];

  profiles(): Promise<string[]> {
    return Promise.resolve(this.names);
  }
  tryConnection(c: Connection): Promise<Tried> {
    this.tried.push(c);
    if (this.refusal !== undefined) return Promise.reject(new Error(this.refusal));
    return Promise.resolve({
      connection: { ...c, region: REGION },
      folders: 3,
      files: 41,
      more: false,
    });
  }
  save(c: Connection): Promise<Connection> {
    this.saved.push(c);
    return Promise.resolve(c);
  }
  known(): readonly Connection[] {
    return this.kept;
  }
}

let asks: Asks;
let listed: Listed;
let sources: Sources;
let panel: Panel;
let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `<aside id="panel" class="panel" hidden></aside>`;
  root = document.querySelector<HTMLElement>("#panel")!;
  asks = new Asks();
  listed = new Listed();
  sources = new Sources(
    listed,
    () => [],
    [],
    () => panel.draw(),
  );
  const noop = (): void => {};
  panel = new Panel(
    root,
    sources,
    () => "default",
    {
      select: noop,
      add: () => Promise.resolve(false),
      append: noop,
      reload: noop,
      repoint: noop,
      remove: noop,
      closed: noop,
    },
    asks,
  );
  panel.show();
});

const form = (): HTMLFormElement => root.querySelector<HTMLFormElement>(".panel-connect")!;
const field = (name: string): HTMLInputElement =>
  form().querySelector<HTMLInputElement>(`input[name=${name}]`)!;
const select = (): HTMLSelectElement => form().querySelector("select")!;
const result = (): string => form().querySelector(".result")!.textContent ?? "";
const region = (): string => form().querySelector(".value")!.textContent ?? "";
const press = (label: string): void =>
  [...form().querySelectorAll("button")].find((b) => b.textContent === label)!.click();
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function type(name: string, value: string): void {
  field(name).value = value;
  field(name).dispatchEvent(new Event("input", { bubbles: true }));
}

test("+ Connect a bucket is a line the keys reach, and Enter opens the form in the list's place", async () => {
  const list = root.querySelector<HTMLElement>(".panel-list")!;
  sources.focus("connections", 0);
  expect(sources.isConnect(sources.place.line)).toBe(true);
  list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();

  expect(form().hidden).toBe(false);
  expect(list.hidden).toBe(true);
  expect(root.querySelector<HTMLElement>(".panel-filter")!.hidden).toBe(true);
  expect(document.activeElement).toBe(field("bucket"));
});

test("the profile list is the engine's names, between this machine and public, with default chosen", async () => {
  panel.connect();
  await settle();
  const options = [...select().options].map((o) => [o.value, o.textContent]);
  expect(options).toEqual([
    ["machine", "this machine's AWS setup"],
    ["profile:default", "default"],
    ["profile:finance", "finance"],
    ["public", "public · no sign-in"],
  ]);
  expect(select().value).toBe("profile:default");
});

test("a test lists the folder and fills in the region nobody typed", async () => {
  panel.connect({ bucket: "acme-exports" });
  await settle();
  expect(region()).toBe("detected by the test");
  type("prefix", "shop");
  select().value = "profile:finance";
  press("Test");
  await settle();

  expect(asks.tried).toEqual([connection()]);
  expect(result()).toBe("✓ listed shop/ · 3 folders, 41 files");
  expect(region()).toBe(`${REGION} · detected`);
  expect(form().querySelector(".fine")!.textContent).toContain(
    "Saves as connections/acme-exports.unof.",
  );
  expect(asks.saved).toEqual([]);
});

// The task's own sentence: a failed test names the reason and saves nothing.
test.each([
  [
    "403",
    "s3://acme-exports: access denied · acme-exports (the AWS profile finance) cannot reach that bucket",
  ],
  ["no such bucket", "s3://acme-exprots: no such bucket"],
  [
    "expired SSO",
    "the AWS profile finance is not signed in · its SSO sign-in expired at 2026-09-20T12:00:00.000Z · sign in with `aws sso login --profile finance`",
  ],
])("a test that fails with %s names the reason and saves nothing", async (_, why) => {
  asks.refusal = why;
  panel.connect({ bucket: "acme-exports" });
  await settle();
  form().requestSubmit();
  await settle();

  expect(result()).toBe(`✗ ${why}`);
  expect(asks.tried).toHaveLength(1);
  expect(asks.saved).toEqual([]);
  expect(form().hidden).toBe(false);
});

test("fields that are not a connection are said before anything is asked", async () => {
  panel.connect();
  await settle();
  expect(form().querySelector(".fine")!.textContent).toMatch(
    /^Each connection is one file in connections\/\./,
  );
  form().requestSubmit();
  await settle();
  expect(result()).toBe("✗ name the bucket to connect");

  type("bucket", "Acme Exports");
  form().requestSubmit();
  await settle();
  expect(result()).toMatch(/^✗ "Acme Exports" is not a bucket name/);
  expect(asks.tried).toEqual([]);
});

// Save tests first when what is on screen has not been tested, and keeps what
// the test found -- the region with it -- and the panel browses it at once.
test("save tests first, keeps the connection the test found, and browses it", async () => {
  panel.connect({ bucket: "acme-exports", prefix: "shop/" });
  await settle();
  select().value = "profile:finance";
  press("Save connection");
  await settle();

  expect(asks.tried).toHaveLength(1);
  expect(asks.saved).toEqual([{ ...connection(), region: REGION }]);
  expect(form().hidden).toBe(true);
  expect(root.querySelector<HTMLElement>(".panel-list")!.hidden).toBe(false);
  expect(listed.asked).toEqual(["s3://acme-exports/shop/"]);
  expect(sources.crumb.map((c) => c.name)).toEqual(["acme-exports / shop"]);
});

test("a test already passed for what is on screen is not asked again on save", async () => {
  panel.connect({ bucket: "acme-exports" });
  await settle();
  press("Test");
  await settle();
  press("Save connection");
  await settle();
  expect(asks.tried).toHaveLength(1);
  expect(asks.saved).toHaveLength(1);
});

// A field changed after a test makes the test about something else: it is
// taken back, and a save tests again.
test("changing a field after a test takes the test back", async () => {
  panel.connect({ bucket: "acme-exports" });
  await settle();
  press("Test");
  await settle();
  type("prefix", "refunds");
  expect(result()).toBe("");
  expect(region()).toBe("detected by the test");
  form().requestSubmit();
  await settle();
  expect(asks.tried.map((c) => c.prefix)).toEqual(["", "refunds/"]);
});

test("Esc gives up, keeps nothing, and gives the list back its place", async () => {
  panel.connect({ bucket: "acme-exports" });
  await settle();
  field("bucket").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(form().hidden).toBe(true);
  expect(root.querySelector<HTMLElement>(".panel-list")!.hidden).toBe(false);
  expect(asks.saved).toEqual([]);
});

// ------------------------------------------------------------ a tab waiting for one

// A .uno that names a bucket nobody connected opens that tab missing, having
// read nothing. Its line offers to connect the bucket and does not offer to
// reload, which would read it with this machine's credentials.
test("a tab in a bucket nobody connected offers Connect, filled in with its folder, and no Reload", async () => {
  const waiting = {
    id: "q4",
    name: "orders.csv",
    link: {
      path: "s3://acme-exports/shop/orders.csv",
      missing: {
        t: "bucket-unconnected",
        container: "q4-close.uno",
        bucket: "acme-exports",
      } satisfies Said,
      connect: { bucket: "acme-exports", prefix: "shop/" },
    },
  };
  const tabs = [waiting, { id: "b", name: "ledger.csv" }];
  document.body.innerHTML = `<aside id="panel" class="panel" hidden></aside>`;
  root = document.querySelector<HTMLElement>("#panel")!;
  sources = new Sources(
    listed,
    () => tabs,
    [],
    () => panel.draw(),
  );
  const noop = (): void => {};
  panel = new Panel(
    root,
    sources,
    () => "default",
    {
      select: noop,
      add: () => Promise.resolve(false),
      append: noop,
      reload: noop,
      repoint: noop,
      remove: noop,
      closed: noop,
    },
    asks,
  );
  panel.show();
  sources.focus("workspace", 0);
  panel.draw();
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));

  expect(stateOf(waiting)).toBe("unconnected");
  expect(sources.doings.map((a) => a.label)).toEqual([
    "Connect acme-exports",
    "Re-point",
    "Remove",
  ]);
  const line = root.querySelector<HTMLElement>(".panel-row.unconnected")!;
  expect([line.children[0]!.textContent, line.children[1]!.textContent]).toEqual([
    "orders.csv",
    "not connected",
  ]);

  [...root.querySelectorAll<HTMLButtonElement>(".panel-foot button")]
    .find((b) => b.textContent === "Connect acme-exports")!
    .click();
  await settle();
  expect(form().hidden).toBe(false);
  expect(field("bucket").value).toBe("acme-exports");
  // The object's folder, which a person can widen to the whole bucket.
  expect(field("prefix").value).toBe("shop/");
  expect(document.activeElement).toBe(field("prefix"));
  expect(asks.tried).toEqual([]);
});

// The keys reach it as the buttons do: c is Connect in Reload's place, and r,
// which would read the bucket with this machine's credentials, does nothing.
test("c on a tab waiting for its bucket connects it, and r does not read it", async () => {
  const waiting = {
    id: "q4",
    name: "orders.csv",
    link: {
      path: "s3://acme-exports/shop/orders.csv",
      missing: {
        t: "bucket-unconnected",
        container: "q4-close.uno",
        bucket: "acme-exports",
      } satisfies Said,
      connect: { bucket: "acme-exports", prefix: "shop/" },
    },
  };
  document.body.innerHTML = `<aside id="panel" class="panel" hidden></aside>`;
  root = document.querySelector<HTMLElement>("#panel")!;
  sources = new Sources(
    listed,
    () => [waiting],
    [],
    () => panel.draw(),
  );
  const reloaded: string[] = [];
  const noop = (): void => {};
  panel = new Panel(
    root,
    sources,
    () => "default",
    {
      select: noop,
      add: () => Promise.resolve(false),
      append: noop,
      reload: (id) => reloaded.push(id),
      repoint: noop,
      remove: noop,
      closed: noop,
    },
    asks,
  );
  panel.show();
  sources.focus("workspace", 0);
  panel.draw();
  const key = (k: string): void => {
    root
      .querySelector(".panel-list")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };

  key("r");
  await settle();
  expect(reloaded).toEqual([]);
  expect(form().hidden).toBe(true);

  key("c");
  await settle();
  expect(form().hidden).toBe(false);
  expect(field("bucket").value).toBe("acme-exports");
});
