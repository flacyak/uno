// The settings control at the bottom left, and the menu it opens: the places
// sources come from, how the page looks, and how the grid reads keys.
//
// It works the way T3 Code's does. One control in the corner opens upward into
// a menu. A theme is worn the moment it is chosen, so choosing is also
// previewing. Light, dark or the system's is a separate choice beside it,
// since every theme has both.
//
// The sources are the top-level places: every connection the engine loaded,
// which is where browsing starts. Choosing one opens the panel browsing it,
// and the menu offers to connect another the way the panel does.
//
// The keys are the input strategy. The window has no menu bar to pick one
// from, so it is picked here.
//
// The language is one of the ones the app has messages for, each under the
// name it calls itself, or whichever of them the system prefers. Choosing one
// writes the whole window again in it, this menu included, without closing
// what is open.
//
// It hangs off the page rather than the status bar, as the + menu does,
// because the status bar is written again on every edit and would take an
// open menu down with it.

import "./settings.css";

import { m } from "../../paraglide/messages.js";
import { INPUTS, inputLabel } from "../input/index.ts";
import type { InputName } from "../input/index.ts";
import { SYSTEM, languageName } from "../language.ts";
import type { Language, LanguageChoice } from "../language.ts";
import type { Connection } from "../sources.ts";
import { APPEARANCES, THEMES } from "../theme.ts";
import type { Appearance, Theming } from "../theme.ts";
import { tabStep, walk } from "./util.ts";

/** What the menu asks of the shell. The shell decides; the menu only asks. */
export interface SettingsAsks {
  /** The connections, read again from the engine, as the panel lists them. */
  connections(): Promise<readonly Connection[]>;
  /** Open the panel browsing one of them. */
  browse(c: Connection): void;
  /** Open the panel's connect screen. */
  connect(): void;
  /** The menu closed, so the keys go back to where they were. */
  closed(): void;
  /** How the grid reads keys now. */
  input(): InputName;
  /** Read keys another way, from here on and at the next launch. */
  setInput(name: InputName): void;
}

/** What each appearance says on its button. */
const APPEARANCE_WORDS: Record<Appearance, () => string> = {
  system: m.appearance_system,
  light: m.appearance_light,
  dark: m.appearance_dark,
};

/** What marks the one chosen among several in a list. */
const CHOSEN = "✓";

/** The gap between the control and the menu it opens above it, in pixels. */
const GAP = 6;

/** A gear, drawn in the ink's colour so every theme wears it. */
const GEAR =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="8" cy="8" r="2.2"/>' +
  '<path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>' +
  "</svg>";

export class Settings {
  private readonly box = document.createElement("div");
  /** Counts opens, so a list of connections that lands after a close is dropped. */
  private opens = 0;
  private connections: readonly Connection[] = [];
  private reading = false;
  private readonly away = (e: MouseEvent): void => {
    const at = e.target as Node;
    if (!this.box.contains(at) && !this.toggle.contains(at)) this.close();
  };

  constructor(
    /** The control in the corner, which the menu opens above. */
    private readonly toggle: HTMLButtonElement,
    private readonly theming: Theming,
    private readonly language: Language,
    private readonly asks: SettingsAsks,
  ) {
    toggle.innerHTML = GEAR;
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => (this.open ? this.close() : this.show()));

    this.box.className = "settings";
    this.box.setAttribute("role", "dialog");
    this.box.hidden = true;
    this.box.addEventListener("keydown", (e) => this.key(e));
    document.body.append(this.box);

    this.label();
    // A theme worn is drawn as chosen whatever chose it.
    theming.onChange(() => {
      if (this.open) this.paint();
    });
    // A language chosen is the one the control and the open menu are in.
    language.onChange(() => {
      this.label();
      if (this.open) this.paint();
    });
  }

  /** label names the control and its menu, for a pointer resting on it and for a screen reader. */
  private label(): void {
    this.toggle.setAttribute("aria-label", m.settings_title());
    this.toggle.title = m.settings_title();
    this.box.setAttribute("aria-label", m.settings_title());
  }

  get open(): boolean {
    return !this.box.hidden;
  }

  /**
   * show opens the menu above the control, with the keys on its first item,
   * and reads the connections again so the list is the engine's as it is now.
   */
  show(): void {
    if (this.open) return;
    const mine = ++this.opens;
    this.box.hidden = false;
    this.toggle.setAttribute("aria-expanded", "true");
    this.toggle.classList.add("on");
    this.place();
    this.reading = true;
    this.paint();
    this.items()[0]?.focus();
    document.addEventListener("mousedown", this.away, true);

    void this.asks.connections().then(
      (list) => {
        if (mine !== this.opens || !this.open) return;
        this.connections = list;
        this.reading = false;
        this.paint();
      },
      () => {
        if (mine !== this.opens || !this.open) return;
        this.reading = false;
        this.paint();
      },
    );
  }

  close(): void {
    if (!this.open) return;
    this.opens++;
    this.box.hidden = true;
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.classList.remove("on");
    document.removeEventListener("mousedown", this.away, true);
    this.asks.closed();
  }

  /** place hangs the menu above the control, its left edge on the control's. */
  private place(): void {
    const at = this.toggle.getBoundingClientRect();
    this.box.style.left = `${Math.round(at.left)}px`;
    this.box.style.bottom = `${Math.round(window.innerHeight - at.top + GAP)}px`;
  }

  /**
   * key reads a key in the menu: the arrows and Tab walk its items, Esc closes
   * it and gives the keys back, and nothing typed here reaches the grid.
   */
  private key(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      this.toggle.focus();
      return;
    }
    walk(e, this.items(), arrowStep);
  }

  /** Every item the keys can land on, in the order they are drawn. */
  private items(): HTMLButtonElement[] {
    return [...this.box.querySelectorAll<HTMLButtonElement>("button")];
  }

  /**
   * paint draws the menu from what is so now: the connections, the theme worn,
   * and the appearance. The item the keys were on keeps them, by its place.
   */
  private paint(): void {
    const focused = this.items().indexOf(document.activeElement as HTMLButtonElement);

    const title = element("div", "title", m.settings_title());
    this.box.replaceChildren(
      title,
      this.sources(),
      this.themes(),
      this.appearances(),
      this.keys(),
      this.languages(),
    );

    if (focused >= 0) this.items()[Math.min(focused, this.items().length - 1)]?.focus();
  }

  /** The places sources come from, each one a way into the panel. */
  private sources(): HTMLElement {
    const section = heading(m.sources_title());
    if (this.reading && this.connections.length === 0) {
      section.append(element("div", "note", m.reading()));
    } else if (this.connections.length === 0) {
      section.append(element("div", "note", m.no_connections()));
    }
    for (const c of this.connections) {
      const item = row(c.name, c.where === undefined ? c.kind : `${c.kind} · ${c.where}`);
      item.title = c.path;
      item.addEventListener("click", () => {
        this.close();
        this.asks.browse(c);
      });
      section.append(item);
    }
    const connect = row(m.connect_action(), "");
    connect.classList.add("action");
    connect.addEventListener("click", () => {
      this.close();
      this.asks.connect();
    });
    section.append(connect);
    return section;
  }

  /** The four themes, each with a chip of its colours in the mode worn now. */
  private themes(): HTMLElement {
    const section = heading(m.settings_theme());
    const mode = this.theming.mode;
    for (const t of THEMES) {
      const chosen = t.id === this.theming.theme.id;
      const item = row(t.name, chosen ? CHOSEN : "");
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(chosen));
      item.dataset["theme"] = t.id;
      item.title = m.settings_theme_credit({ name: t.name, author: t.author });
      if (chosen) item.classList.add("chosen");

      const p = t[mode];
      const chip = element("span", "chip", "");
      chip.style.background = p.surface;
      chip.style.borderColor = p.rule;
      for (const colour of [p.accent, p.ink]) {
        const dot = element("span", "dot", "");
        dot.style.background = colour;
        chip.append(dot);
      }
      item.prepend(chip);
      item.addEventListener("click", () => this.theming.choose(t.id));
      section.append(item);
    }
    return section;
  }

  /** Light, dark, or whatever the system is in, for whichever theme is worn. */
  private appearances(): HTMLElement {
    const section = heading(m.settings_appearance());
    const seg = element("div", "seg", "");
    for (const a of APPEARANCES) {
      const button = element(
        "button",
        a === this.theming.appearance ? "on" : "",
        APPEARANCE_WORDS[a](),
      );
      button.setAttribute("aria-pressed", String(a === this.theming.appearance));
      button.dataset["appearance"] = a;
      button.addEventListener("click", () => this.theming.appear(a));
      seg.append(button);
    }
    section.append(seg);
    return section;
  }

  /** How the grid reads keys: a spreadsheet's, or vim's. */
  private keys(): HTMLElement {
    const section = heading(m.settings_keys());
    const seg = element("div", "seg", "");
    const now = this.asks.input();
    for (const name of INPUTS) {
      const button = element("button", name === now ? "on" : "", inputLabel(name));
      button.setAttribute("aria-pressed", String(name === now));
      button.dataset["input"] = name;
      button.addEventListener("click", () => {
        this.asks.setInput(name);
        this.paint();
      });
      seg.append(button);
    }
    section.append(seg);
    return section;
  }

  /**
   * The languages the app speaks, each under its own name so it can be found
   * by someone who reads no other, and the system's first.
   */
  private languages(): HTMLElement {
    const section = heading(m.settings_language());
    const choices: Array<[LanguageChoice, string]> = [
      [SYSTEM, m.language_system()],
      ...this.language.offered.map((l): [LanguageChoice, string] => [l, languageName(l)]),
    ];
    for (const [choice, name] of choices) {
      const chosen = choice === this.language.choice;
      const item = row(name, chosen ? CHOSEN : "");
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(chosen));
      item.dataset["language"] = choice;
      // The name is in the language itself, and the page is in another.
      if (choice !== SYSTEM) item.lang = choice;
      if (chosen) item.classList.add("chosen");
      item.addEventListener("click", () => this.language.choose(choice));
      section.append(item);
    }
    return section;
  }
}

/** arrowStep reads the arrows as a step through the items, and Tab as one too. */
function arrowStep(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  return tabStep(e);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls !== "") el.className = cls;
  el.textContent = text;
  return el;
}

/** heading is a section of the menu, under its title. */
function heading(title: string): HTMLElement {
  const section = element("section", "", "");
  section.append(element("div", "head", title));
  return section;
}

/** row is one item: what it is, and what is beside it. */
function row(name: string, meta: string): HTMLButtonElement {
  const item = element("button", "item", "");
  item.type = "button";
  item.append(element("span", "name", name), element("span", "meta", meta));
  return item;
}
