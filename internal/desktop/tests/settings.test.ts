// @vitest-environment happy-dom
//
// The settings control and its menu: the top-level sources, the four themes,
// the appearance and the keys, opened upward from the bottom left.
//
// What is under test is what the menu offers and what choosing does: a theme
// is worn the moment it is chosen, a source opens the panel on it, and the
// menu gets out of the way the ways a menu should.

import { beforeEach, expect, test } from "vite-plus/test";

import { Settings } from "../src/renderer/shell/settings.ts";
import type { InputName } from "../src/renderer/input/index.ts";
import type { SettingsAsks } from "../src/renderer/shell/settings.ts";
import type { Connection } from "../src/renderer/sources.ts";
import { Theming } from "../src/renderer/theme.ts";
import type { Keeps, Scheme } from "../src/renderer/theme.ts";

const ACME: Connection = {
  id: "acme-exports",
  name: "ACME exports",
  path: "s3://acme-exports/shop/",
  kind: "s3",
  where: "eu-west-1",
};
const LAKE: Connection = {
  id: "finance-lake",
  name: "Finance lake",
  path: "s3://acme-finance-lake",
  kind: "s3",
};

class Kept implements Keeps {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const light: Scheme = { matches: false, addEventListener: () => {} };

class Asked implements SettingsAsks {
  readonly said: string[] = [];
  list: readonly Connection[] = [ACME, LAKE];
  connections(): Promise<readonly Connection[]> {
    this.said.push("connections");
    return Promise.resolve(this.list);
  }
  browse(c: Connection): void {
    this.said.push(`browse ${c.id}`);
  }
  connect(): void {
    this.said.push("connect");
  }
  closed(): void {
    this.said.push("closed");
  }
  reads: InputName = "default";
  input(): InputName {
    return this.reads;
  }
  setInput(name: InputName): void {
    this.said.push(`input ${name}`);
    this.reads = name;
  }
}

let asked: Asked;
let theming: Theming;
let toggle: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = `<div class="win-status"><button id="settings" class="settings-toggle" type="button"></button></div>`;
  document.documentElement.removeAttribute("style");
  toggle = document.querySelector<HTMLButtonElement>("#settings")!;
  asked = new Asked();
  theming = new Theming(new Kept(), light, document.documentElement);
  new Settings(toggle, theming, asked);
});

const menu = (): HTMLElement => document.querySelector<HTMLElement>(".settings")!;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
/** Each section's items, as what they say, by the section's heading. */
function sections(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of menu().querySelectorAll("section")) {
    const head = s.querySelector(".head")!.textContent!;
    out[head] = [...s.querySelectorAll(".item, .note, .seg button")].map((el) =>
      el.classList.contains("item")
        ? `${el.querySelector(".name")!.textContent}|${el.querySelector(".meta")!.textContent}`
        : el.textContent!,
    );
  }
  return out;
}

test("the control is a gear, labelled, and the menu is closed until it is clicked", () => {
  expect(toggle.querySelector("svg")).not.toBeNull();
  expect(toggle.getAttribute("aria-label")).toBe("Settings");
  expect(menu().hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});

test("clicked, it opens on every top-level source, the four themes, the appearance and the keys", async () => {
  toggle.click();
  await settle();
  expect(menu().hidden).toBe(false);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(sections()).toEqual({
    Sources: ["ACME exports|s3 · eu-west-1", "Finance lake|s3", "+ Connect a bucket|"],
    Theme: ["Paper Ember|✓", "Tokyo Night|", "Sakura|", "Catppuccin Frappé|"],
    Appearance: ["System", "Light", "Dark"],
    Keys: ["Default", "Vim-style"],
  });
  // The keys land in the menu, on its first item.
  expect(document.activeElement?.textContent).toContain("ACME exports");
});

test("with no connections it says so, and still offers to connect one", async () => {
  asked.list = [];
  toggle.click();
  await settle();
  expect(sections()["Sources"]).toEqual(["no connections yet", "+ Connect a bucket|"]);
});

// Choosing is previewing: the page wears the theme at once, and the menu stays
// open on it so the next can be tried.
test("a theme is worn the moment it is chosen, and marked", async () => {
  toggle.click();
  await settle();
  menu().querySelector<HTMLButtonElement>('[data-theme="sakura"]')!.click();
  expect(document.documentElement.dataset["palette"]).toBe("sakura");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#b83d72");
  expect(sections()["Theme"]).toEqual([
    "Paper Ember|",
    "Tokyo Night|",
    "Sakura|✓",
    "Catppuccin Frappé|",
  ]);
  expect(menu().hidden).toBe(false);
});

test("the appearance puts the theme in a mode, and says which it is in", async () => {
  toggle.click();
  await settle();
  menu().querySelector<HTMLButtonElement>('[data-appearance="dark"]')!.click();
  expect(theming.mode).toBe("dark");
  expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#211e1c");
  const on = [...menu().querySelectorAll("[data-appearance].on")].map((b) => b.textContent);
  expect(on).toEqual(["Dark"]);
});

// The window has no menu bar to pick an input strategy from, so it is here.
test("the keys are read another way the moment one is chosen, and it is marked", async () => {
  toggle.click();
  await settle();
  const on = (): (string | null)[] =>
    [...menu().querySelectorAll("[data-input].on")].map((b) => b.textContent);
  expect(on()).toEqual(["Default"]);

  menu().querySelector<HTMLButtonElement>('[data-input="vim-style"]')!.click();

  expect(asked.said.at(-1)).toBe("input vim-style");
  expect(on()).toEqual(["Vim-style"]);
  expect(menu().hidden).toBe(false);
});

test("a chip shows each theme's colours in the mode worn now", async () => {
  theming.appear("dark");
  toggle.click();
  await settle();
  const chip = menu().querySelector<HTMLElement>('[data-theme="tokyo-night"] .chip')!;
  expect(chip.style.background).toBe("#1e202e");
  expect([...chip.querySelectorAll<HTMLElement>(".dot")].map((d) => d.style.background)).toEqual([
    "#7aa2f7",
    "#c0caf5",
  ]);
});

test("a source opens the panel browsing it, and the menu closes", async () => {
  toggle.click();
  await settle();
  menu()
    .querySelectorAll<HTMLButtonElement>("section")[0]!
    .querySelector<HTMLButtonElement>(".item")!
    .click();
  expect(asked.said).toEqual(["connections", "closed", "browse acme-exports"]);
  expect(menu().hidden).toBe(true);
});

test("+ Connect a bucket opens the panel's connect screen", async () => {
  toggle.click();
  await settle();
  [...menu().querySelectorAll<HTMLButtonElement>(".item")]
    .find((b) => b.textContent?.startsWith("+ Connect"))!
    .click();
  expect(asked.said.at(-1)).toBe("connect");
});

test("Esc closes it and gives the keys back to the control", async () => {
  toggle.click();
  await settle();
  menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(menu().hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
  expect(asked.said.at(-1)).toBe("closed");
});

test("a click away closes it, and the control closes it again", async () => {
  toggle.click();
  await settle();
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  expect(menu().hidden).toBe(true);

  toggle.click();
  toggle.click();
  expect(menu().hidden).toBe(true);
});

test("the arrows walk the items, round the ends", async () => {
  toggle.click();
  await settle();
  const key = (k: string): void => {
    menu().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  };
  key("ArrowUp");
  expect(document.activeElement?.textContent).toBe("Vim-style");
  key("ArrowDown");
  expect(document.activeElement?.textContent).toContain("ACME exports");
  key("ArrowDown");
  expect(document.activeElement?.textContent).toContain("Finance lake");
});

// The list is read again on every open, and one that lands after the menu
// closed is for a menu nobody is looking at.
test("connections that land after the menu closed are not drawn into it", async () => {
  let land: (list: readonly Connection[]) => void = () => {};
  asked.connections = () => new Promise((resolve) => (land = resolve));
  toggle.click();
  expect(sections()["Sources"]).toEqual(["reading…", "+ Connect a bucket|"]);
  toggle.click();
  land([ACME]);
  await settle();
  expect(menu().hidden).toBe(true);
  expect(sections()["Sources"]).toEqual(["reading…", "+ Connect a bucket|"]);
});
