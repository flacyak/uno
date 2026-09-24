// @vitest-environment happy-dom
//
// The sidebar's list: the open workspace with its sources under it, then the
// other workspaces opened on this machine, most recent first, and what each
// line asks the shell to do.

import { expect, test } from "vite-plus/test";

import { m } from "../src/paraglide/messages.js";
import { sidebarRows } from "../src/renderer/shell/sidebar.ts";
import type { SidebarActions } from "../src/renderer/shell/sidebar.ts";
import type { Tab, Workspace } from "../src/renderer/workspace.ts";

function tab(id: string, name: string, link?: Tab["link"]): Tab {
  return {
    id,
    name,
    link,
    get trouble() {
      return link?.missing ?? link?.changed;
    },
    get missing() {
      return link?.missing !== undefined;
    },
  } as Tab;
}

function workspace(path: string, tabs: Tab[], dirty = false): Workspace {
  return {
    path,
    sources: tabs,
    active: tabs[0],
    mode: "view",
    dirty,
    suggestedFileName: "google-ads.uno",
    unsaved: () => dirty,
  } as unknown as Workspace;
}

function list(
  w: Workspace | undefined,
  recents: readonly string[] = [],
): { els: HTMLElement[]; asked: string[] } {
  const asked: string[] = [];
  const act: SidebarActions = {
    open: (path) => asked.push(`open ${path}`),
    menu: (path, place) => asked.push(`menu ${path} ${place.left},${place.top}`),
    select: (t) => asked.push(`select ${t.id}`),
    remove: (t) => asked.push(`remove ${t.id}`),
    add: () => asked.push("add"),
    repoint: (t) => asked.push(`repoint ${t.id}`),
  };
  return { els: sidebarRows(w, recents, act), asked };
}

/** One source, as the workspace the old strip's tests were about. */
function one(link: Tab["link"]): { els: HTMLElement[]; asked: string[] } {
  return list(workspace("/work/q3-close.uno", [tab("b", "google-ads.csv", link)]));
}

const names = (els: HTMLElement[]): string[] =>
  els.map((el) => `${el.className}:${el.querySelector(".name")?.textContent ?? el.textContent}`);

test("with nothing open and nothing opened before, the list says so", () => {
  const { els } = list(undefined);
  expect(els.map((el) => el.textContent)).toEqual([m.no_workspaces()]);
});

test("the open workspace comes first with its sources under it, then the others, most recent first", () => {
  const w = workspace("/work/q3-close.uno", [tab("a", "sales-q3.csv"), tab("b", "google-ads.csv")]);
  const { els } = list(w, ["/work/q3-close.uno", "/work/liquidity.uno", "/archive/q2-close.UNO"]);
  expect(names(els)).toEqual([
    "ws open:q3-close",
    "tab active:sales-q3.csv",
    "tab:google-ads.csv",
    "tab-add:+ add source",
    "ws:liquidity",
    "ws:q2-close",
  ]);
});

test("a workspace's line names the folder it is in, and its whole path on hover", () => {
  const { els } = list(undefined, ["/work/exports/q3-close.uno"]);
  expect(els[0]!.querySelector(".meta")?.textContent).toBe("exports");
  expect(els[0]!.title).toBe("/work/exports/q3-close.uno");
});

test("a workspace never saved is named for its first source, and says it is not saved", () => {
  const { els } = list(workspace("", [tab("b", "google-ads.csv")]), ["/work/liquidity.uno"]);
  expect(els[0]!.querySelector(".name")?.textContent).toBe("google-ads");
  expect(els[0]!.querySelector(".meta")?.textContent).toBe(m.not_saved());
  expect(names(els).at(-1)).toBe("ws:liquidity");
});

test("clicking another workspace asks to open it, and clicking the open one asks nothing", () => {
  const w = workspace("/work/q3-close.uno", [tab("a", "sales-q3.csv")]);
  const { els, asked } = list(w, ["/work/q3-close.uno", "/work/liquidity.uno"]);
  els[0]!.click();
  els.at(-1)!.click();
  expect(asked).toEqual(["open /work/liquidity.uno"]);
});

test("a right click on a workspace asks for its menu where the pointer is", () => {
  const w = workspace("", [tab("a", "sales-q3.csv")]);
  const { els, asked } = list(w, ["/work/liquidity.uno"]);
  const at = { bubbles: true, cancelable: true, clientX: 40, clientY: 90 };

  const onOpen = new MouseEvent("contextmenu", at);
  els[0]!.dispatchEvent(onOpen);
  const onOther = new MouseEvent("contextmenu", at);
  els.at(-1)!.dispatchEvent(onOther);

  expect(asked).toEqual(["menu  40,90", "menu /work/liquidity.uno 40,90"]);
  // The page's own menu stays away.
  expect(onOpen.defaultPrevented && onOther.defaultPrevented).toBe(true);
});

test("the open workspace wears a dot while a save would change it", () => {
  const clean = list(workspace("/work/q3-close.uno", [tab("a", "sales-q3.csv")]));
  const dirty = list(workspace("/work/q3-close.uno", [tab("a", "sales-q3.csv")], true));
  expect(clean.els[0]!.querySelector(".dirty")).toBeNull();
  expect(dirty.els[0]!.querySelector(".dirty")).not.toBeNull();
});

test("the + under the sources asks to add one", () => {
  const { els, asked } = one({ path: "/home/jo/ledger-2025.csv" });
  els.find((el) => el.className === "tab-add")!.click();
  expect(asked).toEqual(["add"]);
});

test("the last source has no ×, and one of several asks to be removed without being selected", () => {
  expect(one({ path: "/home/jo/ledger-2025.csv" }).els[1]!.querySelector(".close")).toBeNull();

  const w = workspace("/work/q3-close.uno", [tab("a", "sales-q3.csv"), tab("b", "google-ads.csv")]);
  const { els, asked } = list(w);
  els[2]!.querySelector<HTMLElement>(".close")!.click();
  expect(asked).toEqual(["remove b"]);
});

test("the ! mark asks to re-point the tab from the panel, and does not select it", () => {
  const { els, asked } = one({
    path: "s3://acme-exports/ads/google-ads.csv",
    missing: "google-ads.csv is not there",
  });
  const mark = els[1]!.querySelector<HTMLElement>(".trouble")!;
  expect(mark.className).toBe("trouble gone");
  expect(mark.title).toContain("sources panel");

  mark.click();

  expect(asked).toEqual(["repoint b"]);
});

test("a tab with nothing wrong has no mark", () => {
  const { els } = one({ path: "/home/jo/ledger-2025.csv" });
  expect(els[1]!.querySelector(".trouble")).toBeNull();
});

// A name longer than the sidebar is cut short, so the name is in a box that
// can be, and the whole of it is on the tab for whoever hovers.
test("a tab's name is a box of its own, and whole in its title", () => {
  const { els } = one({ path: "/home/jo/ledger-2025.csv" });
  const source = els[1]!;
  expect(source.querySelector(".name")?.textContent).toBe(source.title);
  expect(source.title).not.toBe("");
});
