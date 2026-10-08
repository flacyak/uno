// What every part of the shell reaches for: an element the markup promised, and
// an error as something to say.

import { said } from "../said.ts";

export function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
}

/** found is the element the markup promised under a selector. */
export function found<E extends HTMLElement = HTMLElement>(selector: string): E {
  return must(document.querySelector<E>(selector));
}

/** Handlers is one function for each kind of a union tagged by `t`, so a kind left out is a type error. */
export type Handlers<U extends { t: string }> = {
  [K in U["t"]]: (u: Extract<U, { t: K }>) => void;
};

/** dispatch hands a tagged value to its kind's handler. */
export function dispatch<U extends { t: string }>(handlers: Handlers<U>, u: U): void {
  // The table is typed by kind, and u is the union, so the one pairing the
  // compiler cannot see is said here: each handler takes its own kind.
  (handlers[u.t as U["t"]] as (u: U) => void)(u);
}

/**
 * el is one element as the shell makes most of them: a tag, the class it
 * wears, and the text in it. Either may be left out, and an empty class is
 * no class at all, so the markup stays as index.html would have written it.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (cls !== "") made.className = cls;
  if (text !== "") made.textContent = text;
  return made;
}

/**
 * hang places a surface hung off the page at `place`, moved in from the bottom
 * or the right of the window until the whole of it shows, `edge` pixels clear.
 */
export function hang(box: HTMLElement, place: { left: number; top: number }, edge: number): void {
  const { width, height } = box.getBoundingClientRect();
  const left = Math.min(place.left, window.innerWidth - width - edge);
  const top = Math.min(place.top, window.innerHeight - height - edge);
  box.style.left = `${Math.max(edge, left)}px`;
  box.style.top = `${Math.max(edge, top)}px`;
}

/**
 * clickAway has a click outside a surface close it, armed after the click
 * that opened it has finished, or it would close what it opened. It answers
 * the disarm, for the close.
 */
export function clickAway(box: HTMLElement, close: () => void): () => void {
  const away = (e: MouseEvent): void => {
    if (!box.contains(e.target as Node)) close();
  };
  setTimeout(() => document.addEventListener("mousedown", away), 0);
  return () => document.removeEventListener("mousedown", away);
}

/** option is one choice in a select: what it says, and the value it stands for. */
export function option(label: string, value: string): HTMLOptionElement {
  const made = el("option", "", label);
  made.value = value;
  return made;
}

/**
 * Words are the texts a component writes once, when it is built, kept so they
 * can be written again in another language. What a component paints on every
 * change needs none of this, since its next paint is already in the language
 * the app is in by then.
 */
export class Words {
  private readonly writers: Array<() => void> = [];

  /** text keeps an element's text as whatever `say` answers, and hands the element back. */
  text<E extends HTMLElement>(el: E, say: () => string): E {
    return this.keep(el, () => (el.textContent = say()));
  }

  /** attr keeps one of an element's attributes as whatever `say` answers. */
  attr<E extends HTMLElement>(el: E, name: string, say: () => string): E {
    return this.keep(el, () => el.setAttribute(name, say()));
  }

  /** placeholder keeps what a field shows before anything is typed in it. */
  placeholder<E extends HTMLInputElement>(el: E, say: () => string): E {
    return this.keep(el, () => (el.placeholder = say()));
  }

  /** write writes every one of them again, in the language the app is in now. */
  write(): void {
    for (const write of this.writers) write();
  }

  private keep<E extends HTMLElement>(el: E, write: () => void): E {
    this.writers.push(write);
    write();
    return el;
  }
}

/**
 * walk moves the keys through the controls of a surface hung off the page,
 * one step along and round the ends. The surface sits after the page in the
 * document, so Tab left alone would carry the keys out of it, to the
 * window's × behind it or the grid, with the surface still open: Tab and
 * Shift+Tab walk it instead, and so do whatever other keys the surface reads
 * as a step. It answers whether the key was one.
 */
export function walk(
  e: KeyboardEvent,
  controls: readonly HTMLElement[],
  stepOf: (e: KeyboardEvent) => 1 | -1 | 0 = tabStep,
): boolean {
  const step = stepOf(e);
  if (step === 0) return false;
  e.preventDefault();
  // A control that is disabled takes no focus, and a step that stopped on it
  // would stop there for good: it is stepped over.
  const live = controls.filter((c) => !c.hasAttribute("disabled"));
  // With nothing to land on, the key is left to the page rather than swallowed.
  if (live.length === 0) return false;
  const at = live.indexOf(document.activeElement as HTMLElement);
  // From outside the controls, a step forward lands on the first and one
  // back on the last, as it would from the end either step walks past.
  const from = at >= 0 ? at : step > 0 ? -1 : live.length;
  live[(from + step + live.length) % live.length]?.focus();
  return true;
}

/** tabStep reads Tab as a step forward and Shift+Tab as one back. */
export function tabStep(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.key !== "Tab") return 0;
  return e.shiftKey ? -1 : 1;
}

/**
 * message is what an error says, to say to a person: in the app's language
 * where the engine sent it as data, and as it was written otherwise.
 */
export function message(err: unknown): string {
  return said(err);
}

/**
 * settled is `run` once `ms` pass with no trigger, and never twice at once:
 * a trigger while a run is out is answered by that run. It is how the window
 * getting the focus asks the buckets -- alt-tabbing through the window on the
 * way somewhere else asks nothing, and coming back asks once.
 */
export function settled(ms: number, run: () => Promise<void>): () => void {
  let wait: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  return () => {
    clearTimeout(wait);
    wait = setTimeout(() => {
      if (running) return;
      running = true;
      void run().finally(() => {
        running = false;
      });
    }, ms);
  };
}

/** The last part of a path, whichever way its separators lean. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** The folder a path is in, by its own name: "exports" for /work/exports/q3.uno. */
export function folderName(path: string): string {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end < 0 ? "" : baseName(path.slice(0, end));
}
