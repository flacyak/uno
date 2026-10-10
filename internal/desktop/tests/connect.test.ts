// @vitest-environment happy-dom
//
// The connect form in the panel: its fields, the sign-in modes the engine
// offers, Test (which lists the folder), and Save.
//
// A failed test shows the engine's error and stops there. A save tests
// first, keeps the connection the test returned with its region, and the
// panel browses it.

import { beforeEach, expect, test } from "vite-plus/test";

import type { Peeked, Said, SignIns, SourceRef } from "@uno/grid/engine";
import type { Connection } from "@uno/grid/library";
import type { Listing } from "@uno/grid/store";
import type { Tried } from "@uno/grid/store/s3";

import type { ConnectAsks } from "../src/renderer/shell/connect.ts";
import { draftOf, folderOf, triedLine } from "../src/renderer/shell/connect.ts";
import { Panel } from "../src/renderer/shell/panel.ts";
import type { Listings } from "../src/renderer/sources.ts";
import { Sources, stateOf } from "../src/renderer/sources.ts";

const REGION = "eu-west-1";

/** A role in the person's account, and the trust the hosted engine reports. */
const ROLE = "arn:aws:iam::210987654321:role/uno-read";
const TRUST = { principal: "arn:aws:iam::111122223333:role/uno-engine", externalId: "ext-4f9c" };

/** The sign-in modes the desktop's engine offers. */
const DESKTOP: SignIns["modes"] = ["machine", "profile", "public"];

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
  // The role ARN is read when the role mode is chosen, and trimmed.
  expect(
    draftOf({ bucket: "lake", prefix: "", signIn: "role", roleArn: ` ${ROLE} ` }, []).auth,
  ).toEqual({ mode: "role", roleArn: ROLE });
});

// A second folder of one bucket gets a new id. The same folder again reuses
// the kept connection's id and created date.
test("an id already kept for another folder is not taken; the same folder keeps its own", () => {
  const kept = [connection({ prefix: "refunds/", created: new Date("2026-09-01T00:00:00Z") })];
  expect(draftOf({ bucket: "acme-exports", prefix: "shop", signIn: "machine" }, kept).id).toBe(
    "acme-exports-2",
  );
  const again = draftOf({ bucket: "acme-exports", prefix: "refunds", signIn: "machine" }, kept);
  expect(again.id).toBe("acme-exports");
  expect(again.created).toEqual(kept[0]!.created);
});

// A connection made again keeps the unrecognised keys of the kept one, in
// both the connection and its auth block.
test("the same folder made again carries what this build did not recognise", () => {
  const extra = new Map<string, unknown>([["sso_session", "corp"]]);
  const authExtra = new Map<string, unknown>([["sso_account_id", "123456789012"]]);
  const kept = [
    connection({ extra, auth: { mode: "profile", profile: "finance", extra: authExtra } }),
  ];

  const same = draftOf({ bucket: "acme-exports", prefix: "shop", signIn: "profile:finance" }, kept);
  expect(same.extra).toEqual(extra);
  expect(same.auth).toEqual({ mode: "profile", profile: "finance", extra: authExtra });

  // A different sign-in mode is a fresh auth block of the mode alone.
  const other = draftOf({ bucket: "acme-exports", prefix: "shop", signIn: "machine" }, kept);
  expect(other.extra).toEqual(extra);
  expect(other.auth).toEqual({ mode: "machine" });
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

/** Listings that answer any path with one file, and record what was asked. */
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

/** A ConnectAsks that answers as the test sets it up, and records what was asked. */
class Asks implements ConnectAsks {
  tried: Connection[] = [];
  saved: Connection[] = [];
  refusal: string | undefined;
  offered: SignIns = { modes: DESKTOP, profiles: ["default", "finance"] };
  kept: Connection[] = [];

  signIns(): Promise<SignIns> {
    return Promise.resolve(this.offered);
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

test("the sign-in list is the engine's profiles, between this machine and public, with default chosen", async () => {
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
  // Role is absent from the desktop's modes, so the role field is hidden.
  expect(field("roleArn").closest("label")!.hidden).toBe(true);
  expect(form().querySelector(".fine")!.textContent).toBe(
    "Each connection is one file in connections/. The profile list is read from ~/.aws; uno stores the name, never the keys.",
  );
});

// With a role mode on offer, the form asks for the role's ARN and shows the
// trust the engine reports: its principal and the external ID.
test("an engine that signs in with a role asks for its ARN and says what the role has to trust", async () => {
  asks.offered = { modes: ["role", "public"], profiles: [], trust: TRUST };
  panel.connect({ bucket: "acme-finance-lake" });
  await settle();
  expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([
    ["role", "a role in your account"],
    ["public", "public · no sign-in"],
  ]);
  expect(select().value).toBe("role");
  const row = field("roleArn").closest("label")!;
  expect(row.hidden).toBe(false);
  expect(form().querySelector(".trust")!.textContent).toBe(
    `Its trust policy lets ${TRUST.principal} assume it with external ID ${TRUST.externalId}.`,
  );
  expect(form().querySelector(".fine")!.textContent).toBe(
    "Each connection is one file in connections/. uno stores the role's ARN and never a key; what lets uno read is the role's own trust policy.",
  );

  // An empty ARN, and a bare name, are refused before the engine is asked.
  form().requestSubmit();
  await settle();
  expect(result()).toBe("✗ name the role to assume");
  type("roleArn", "uno-read");
  form().requestSubmit();
  await settle();
  expect(result()).toBe(
    `✗ "uno-read" is not a role's ARN · one reads arn:aws:iam::123456789012:role/name`,
  );
  expect(asks.tried).toEqual([]);

  type("roleArn", ROLE);
  expect(form().querySelector(".fine")!.textContent).toBe(
    "Saves as connections/acme-finance-lake.unof. uno stores the role's ARN and never a key; what lets uno read is the role's own trust policy.",
  );
  press("Test");
  await settle();
  expect(asks.tried.map((c) => c.auth)).toEqual([{ mode: "role", roleArn: ROLE }]);
  expect(result()).toBe("✓ listed the bucket · 3 folders, 41 files");

  // Choosing public hides the role field and the trust line.
  select().value = "public";
  select().dispatchEvent(new Event("change", { bubbles: true }));
  expect(row.hidden).toBe(true);
  expect(form().querySelector<HTMLElement>(".trust")!.hidden).toBe(true);
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

// A failed test shows the engine's reason and stops there.
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

  expect(asks.tried).toHaveLength(1);
  expect(asks.saved).toEqual([]);
  // The reason is shown in the panel foot and in the form.
  expect(root.querySelector(".panel-foot .why")!.textContent).toBe(`✗ ${why}`);
  expect(result()).toBe(`✗ ${why}`);
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

// Save tests first when the draft is untested, keeps the connection the test
// returned with its region, and browses it.
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

test("a save steps aside for a line that says connecting, until it is kept or refused", async () => {
  const list = root.querySelector<HTMLElement>(".panel-list")!;
  const line = (cls: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`.panel-row.${cls}`);
  const foot = (): HTMLElement => root.querySelector<HTMLElement>(".panel-foot")!;
  // tryConnection settles only when the test calls `answer`.
  let answer: { worked(): void; refused(why: string): void } | undefined;
  asks.tryConnection = (c) =>
    new Promise<Tried>((resolve, reject) => {
      answer = {
        worked: () =>
          resolve({ connection: { ...c, region: REGION }, folders: 3, files: 41, more: false }),
        refused: (why) => reject(new Error(why)),
      };
    });

  panel.connect();
  type("bucket", "acme-exprots");
  type("prefix", "shop");
  press("Save connection");
  await settle();

  // The list is shown. The connecting line is selected, and sits just before
  // the "+ Connect a bucket" line.
  expect(form().hidden).toBe(true);
  expect(list.hidden).toBe(false);
  expect(line("opening")!.children[0]!.textContent).toBe("acme-exprots / shop");
  expect(line("opening")!.children[1]!.textContent).toBe("connecting…");
  expect(line("opening")!.classList.contains("sel")).toBe(true);
  expect(sources.isConnect(sources.place.line + 1)).toBe(true);

  // A click on a connecting line leaves the form hidden.
  line("opening")!.click();
  expect(form().hidden).toBe(true);

  // When refused, the line stays and says failed. The reason is in the foot
  // and in the line's title.
  answer!.refused("404 · no such bucket");
  await settle();
  expect(line("opening")).toBeNull();
  expect(line("failed")!.children[0]!.textContent).toBe("acme-exprots / shop");
  expect(line("failed")!.children[1]!.textContent).toBe("failed");
  expect(line("failed")!.title).toBe("404 · no such bucket");
  expect(form().hidden).toBe(true);
  expect(foot().hidden).toBe(false);
  expect(foot().querySelector(".why")!.textContent).toBe("✗ 404 · no such bucket");
  expect(asks.saved).toEqual([]);

  // Enter on the failed line reopens the form with its fields and the reason.
  list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(form().hidden).toBe(false);
  expect(list.hidden).toBe(true);
  expect(result()).toBe("✗ 404 · no such bucket");
  expect(field("bucket").value).toBe("acme-exprots");
  expect(document.activeElement).toBe(field("bucket"));

  // Edited and saved: tried again, kept, and browsed. Every line is settled.
  type("bucket", "acme-exports");
  press("Save connection");
  await settle();
  expect(line("failed")).toBeNull();
  expect(line("opening")!.children[0]!.textContent).toBe("acme-exports / shop");
  answer!.worked();
  await settle();
  await new Promise((r) => requestAnimationFrame(r));
  expect(asks.saved.map((c) => c.id)).toEqual(["acme-exports"]);
  expect(line("opening")).toBeNull();
  expect(form().hidden).toBe(true);
  expect(sources.crumb.map((c) => c.name)).toEqual(["acme-exports / shop"]);
});

test("the button under a refused connection edits it, and Cancel gives it up", async () => {
  asks.refusal = "403 · AccessDenied";
  panel.connect({ bucket: "acme-exports" });
  press("Save connection");
  await settle();

  const edit = [...root.querySelectorAll<HTMLButtonElement>(".panel-foot button")].find(
    (b) => b.textContent === "Edit connection",
  )!;
  edit.click();
  expect(form().hidden).toBe(false);
  expect(result()).toBe("✗ 403 · AccessDenied");

  press("Cancel");
  await settle();
  await new Promise((r) => requestAnimationFrame(r));
  expect(form().hidden).toBe(true);
  expect(sources.connecting).toBeUndefined();
  expect(root.querySelector(".panel-row.failed")).toBeNull();
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

// Changing a field after a test clears the result, and a save tests again.
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

// Until signIns answers, public is the only option. When the modes arrive,
// the select moves to the default profile, which clears the test result like
// typing would.
test("the sign-in list arriving after a test takes the test back", async () => {
  let offer: (offered: SignIns) => void = () => {};
  asks.signIns = () => new Promise<SignIns>((resolve) => (offer = resolve));
  panel.connect({ bucket: "acme-exports" });
  await settle();
  expect([...select().options].map((o) => o.value)).toEqual(["public"]);
  press("Test");
  await settle();
  expect(asks.tried.map((c) => c.auth)).toEqual([{ mode: "public" }]);
  expect(result()).toBe("✓ listed the bucket · 3 folders, 41 files");

  offer({ modes: DESKTOP, profiles: ["default"] });
  await settle();
  expect(select().value).toBe("profile:default");
  expect(result()).toBe("");
  expect(region()).toBe("detected by the test");
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

// A tab in a bucket outside every connection is "unconnected". Its actions
// offer Connect in place of Reload.
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
  // The prefix is filled with the object's folder.
  expect(field("prefix").value).toBe("shop/");
  expect(document.activeElement).toBe(field("prefix"));
  expect(asks.tried).toEqual([]);
});

// On an unconnected tab, c opens Connect and r leaves `tried` empty.
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
