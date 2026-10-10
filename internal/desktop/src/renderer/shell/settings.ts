// The settings control at the bottom left, and the menu it opens upward: the
// connections, the theme, the appearance, the input strategy, and the
// language.
//
// Choosing a theme or appearance applies it at once. Choosing a language
// rewrites the whole window, this menu included, and everything stays open.
//
// The menu is appended to document.body, because the status bar is redrawn
// on every edit and would remove an open menu.

import "./settings.css";

import { m } from "../../paraglide/messages.js";
import { INPUTS, inputLabel } from "../input/index.ts";
import type { InputName } from "../input/index.ts";
import { SYSTEM, languageName } from "../language.ts";
import type { Language, LanguageChoice } from "../language.ts";
import type { Connection } from "../sources.ts";
import { APPEARANCES, THEMES } from "../theme.ts";
import type { Appearance, Theming } from "../theme.ts";
import { el, tabStep, walk } from "./util.ts";

/** What the menu asks of the shell. */
export interface SettingsAsks {
  /** The connections, read again from the engine. */
  connections(): Promise<readonly Connection[]>;
  /** Open the panel browsing a connection. */
  browse(c: Connection): void;
  /** Open the panel's connect form. */
  connect(): void;
  /** Called when the menu closes. */
  closed(): void;
  /** The current input strategy. */
  input(): InputName;
  /** Change the input strategy, now and for the next launch. */
  setInput(name: InputName): void;
}

/** The label for each appearance. */
const APPEARANCE_WORDS: Record<Appearance, () => string> = {
  system: m.appearance_system,
  light: m.appearance_light,
  dark: m.appearance_dark,
};

/** The mark beside the chosen item in a list. */
const CHOSEN = "✓";

/** The gap between the control and the menu above it, in pixels. */
const GAP = 6;

/** The gear icon, drawn in currentColor. */
const GEAR =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="8" cy="8" r="2.2"/>' +
  '<path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>' +
  "</svg>";

export class Settings {
  private readonly box = document.createElement("div");
  /**
   * Counts opens, so a list of connections that lands after a close is dropped.
   */
  private opens = 0;
  private connections: readonly Connection[] = [];
  private reading = false;
  private readonly away = (e: MouseEvent): void => {
    const at = e.target as Node;
    if (!this.box.contains(at) && !this.toggle.contains(at)) this.close();
  };

  constructor(
    /** The control in the corner the menu opens above. */
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
    // Repaint when the theme changes, whatever changed it.
    theming.onChange(() => {
      if (this.open) this.paint();
    });
    // Relabel when the language changes.
    language.onChange(() => {
      this.label();
      if (this.open) this.paint();
    });
  }

  /**
   * label sets the control's hover text and the aria labels of the control and
   * the menu.
   */
  private label(): void {
    this.toggle.setAttribute("aria-label", m.settings_title());
    this.toggle.title = m.settings_title();
    this.box.setAttribute("aria-label", m.settings_title());
  }

  get open(): boolean {
    return !this.box.hidden;
  }

  /**
   * show opens the menu above the control, focuses its first item, and reads
   * the connections again.
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

  /** place positions the menu above the control, left edges aligned. */
  private place(): void {
    const at = this.toggle.getBoundingClientRect();
    this.box.style.left = `${Math.round(at.left)}px`;
    this.box.style.bottom = `${Math.round(window.innerHeight - at.top + GAP)}px`;
  }

  /**
   * key handles a key in the menu: the arrows and Tab move through the items,
   * and Esc closes it. Every key stops at the menu.
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

  /** Every button in the menu, in document order. */
  private items(): HTMLButtonElement[] {
    return [...this.box.querySelectorAll<HTMLButtonElement>("button")];
  }

  /**
   * paint rebuilds the menu's contents. Focus stays on the item at the same
   * position.
   */
  private paint(): void {
    const focused = this.items().indexOf(document.activeElement as HTMLButtonElement);

    const title = el("div", "title", m.settings_title());
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

  /**
   * The connections section: each one opens the panel on it, then a Connect
   * item.
   */
  private sources(): HTMLElement {
    const section = heading(m.sources_title());
    if (this.reading && this.connections.length === 0) {
      section.append(el("div", "note", m.reading()));
    } else if (this.connections.length === 0) {
      section.append(el("div", "note", m.no_connections()));
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

  /**
   * The themes section, each with a chip of its colours in the current mode.
   */
  private themes(): HTMLElement {
    const section = heading(m.settings_theme());
    const mode = this.theming.mode;
    for (const t of THEMES) {
      const chosen = t.id === this.theming.theme.id;
      const item = radio(t.name, chosen, "theme", t.id, () => this.theming.choose(t.id));
      item.title = m.settings_theme_credit({ name: t.name, author: t.author });

      const p = t[mode];
      const chip = el("span", "chip");
      chip.style.background = p.surface;
      chip.style.borderColor = p.rule;
      for (const colour of [p.accent, p.ink]) {
        const dot = el("span", "dot");
        dot.style.background = colour;
        chip.append(dot);
      }
      item.prepend(chip);
      section.append(item);
    }
    return section;
  }

  /** The appearance section: system, light, or dark. */
  private appearances(): HTMLElement {
    const on = this.theming.appearance;
    const word = (a: Appearance): string => APPEARANCE_WORDS[a]();
    return segment(m.settings_appearance(), APPEARANCES, on, word, "appearance", (a) =>
      this.theming.appear(a),
    );
  }

  /** The input strategy section. */
  private keys(): HTMLElement {
    const on = this.asks.input();
    return segment(m.settings_keys(), INPUTS, on, inputLabel, "input", (name) => {
      this.asks.setInput(name);
      this.paint();
    });
  }

  /**
   * The languages section: the system's choice first, then each language
   * under its own name.
   */
  private languages(): HTMLElement {
    const section = heading(m.settings_language());
    const choices: Array<[LanguageChoice, string]> = [
      [SYSTEM, m.language_system()],
      ...this.language.offered.map((l): [LanguageChoice, string] => [l, languageName(l)]),
    ];
    for (const [choice, name] of choices) {
      const chosen = choice === this.language.choice;
      const item = radio(name, chosen, "language", choice, () => this.language.choose(choice));
      // The name is written in its own language.
      if (choice !== SYSTEM) item.lang = choice;
      section.append(item);
    }
    return section;
  }
}

/**
 * radio is one item of a list with one chosen: its name, the chosen mark,
 * and `data-<key>` set to `value`.
 */
function radio(
  name: string,
  chosen: boolean,
  key: string,
  value: string,
  choose: () => void,
): HTMLElement {
  const item = row(name, chosen ? CHOSEN : "");
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", String(chosen));
  item.dataset[key] = value;
  if (chosen) item.classList.add("chosen");
  item.addEventListener("click", choose);
  return item;
}

/** segment is a section of buttons side by side, one of them pressed. */
function segment<T extends string>(
  title: string,
  choices: readonly T[],
  on: T,
  label: (choice: T) => string,
  key: string,
  choose: (choice: T) => void,
): HTMLElement {
  const section = heading(title);
  const seg = el("div", "seg");
  for (const c of choices) {
    const button = el("button", c === on ? "on" : "", label(c));
    button.setAttribute("aria-pressed", String(c === on));
    button.dataset[key] = c;
    button.addEventListener("click", () => choose(c));
    seg.append(button);
  }
  section.append(seg);
  return section;
}

/** arrowStep reads the arrow keys as steps, and Tab as tabStep does. */
function arrowStep(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  return tabStep(e);
}

/** heading creates a section with its title. */
function heading(title: string): HTMLElement {
  const section = el("section");
  section.append(el("div", "head", title));
  return section;
}

/** row creates one item button: a name and text beside it. */
function row(name: string, meta: string): HTMLButtonElement {
  const item = el("button", "item");
  item.type = "button";
  item.append(el("span", "name", name), el("span", "meta", meta));
  return item;
}
