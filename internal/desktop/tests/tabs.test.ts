// @vitest-environment happy-dom
//
// The tab strip's ! mark. It used to open the local file dialog through
// `host.add()`; it now asks the shell to re-point from the sources panel, so a
// source in S3 can be pointed at another object.

import { expect, test } from "vite-plus/test";

import { tabStrip } from "../src/renderer/shell/tabs.ts";
import type { TabActions } from "../src/renderer/shell/tabs.ts";
import type { Tab, Workspace } from "../src/renderer/workspace.ts";

function strip(link: Tab["link"]): { els: HTMLElement[]; asked: string[] } {
  const tab = {
    id: "b",
    name: "google-ads.csv",
    link,
    get trouble() {
      return link?.missing ?? link?.changed;
    },
    get missing() {
      return link?.missing !== undefined;
    },
  } as Tab;
  const w = {
    sources: [tab],
    active: tab,
    mode: "view",
    unsaved: () => false,
  } as unknown as Workspace;
  const asked: string[] = [];
  const act: TabActions = {
    toggle: () => asked.push("toggle"),
    select: (t) => asked.push(`select ${t.id}`),
    remove: (t) => asked.push(`remove ${t.id}`),
    add: () => asked.push("add"),
    repoint: (t) => asked.push(`repoint ${t.id}`),
    panel: () => asked.push("panel"),
  };
  return { els: tabStrip(w, "", false, act), asked };
}

test("the ! mark asks to re-point the tab from the panel, and does not select it", () => {
  const { els, asked } = strip({
    path: "s3://acme-exports/ads/google-ads.csv",
    missing: "google-ads.csv is not there",
  });
  const mark = els[0]!.querySelector<HTMLElement>(".trouble")!;
  expect(mark.className).toBe("trouble gone");
  expect(mark.title).toContain("sources panel");

  mark.click();

  expect(asked).toEqual(["repoint b"]);
});

test("a tab with nothing wrong has no mark", () => {
  const { els } = strip({ path: "/home/jo/ledger-2025.csv" });
  expect(els[0]!.querySelector(".trouble")).toBeNull();
});
