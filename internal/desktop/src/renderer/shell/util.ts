// Helpers shared by the shell's files.

import { said } from "../said.ts";

export function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
}

/**
 * found returns the element matching `selector`, and throws if there is none.
 */
export function found<E extends HTMLElement = HTMLElement>(selector: string): E {
  return must(document.querySelector<E>(selector));
}

/**
 * Handlers is one function per kind of a union tagged by `t`. Leaving a kind
 * out is a type error.
 */
export type Handlers<U extends { t: string }> = {
  [K in U["t"]]: (u: Extract<U, { t: K }>) => void;
};

/** dispatch calls the handler for a tagged value's kind. */
export function dispatch<U extends { t: string }>(handlers: Handlers<U>, u: U): void {
  // The cast tells the compiler that each handler takes its own kind, a link
  // the union hides from it.
  (handlers[u.t as U["t"]] as (u: U) => void)(u);
}

/**
 * el creates an element with a class name and text content. An empty class
 * or text leaves the element as created.
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
 * hang positions a fixed element at `place`, moved left or up as needed so
 * the whole of it fits in the window with `edge` pixels to spare.
 */
export function hang(box: HTMLElement, place: { left: number; top: number }, edge: number): void {
  const { width, height } = box.getBoundingClientRect();
  const left = Math.min(place.left, window.innerWidth - width - edge);
  const top = Math.min(place.top, window.innerHeight - height - edge);
  box.style.left = `${Math.max(edge, left)}px`;
  box.style.top = `${Math.max(edge, top)}px`;
}

/**
 * clickAway calls `close` on a mousedown outside `box`. The listener is
 * added on the next tick, so the click that opened the box leaves it open.
 * Returns a function that removes the listener.
 */
export function clickAway(box: HTMLElement, close: () => void): () => void {
  const away = (e: MouseEvent): void => {
    if (!box.contains(e.target as Node)) close();
  };
  setTimeout(() => document.addEventListener("mousedown", away), 0);
  return () => document.removeEventListener("mousedown", away);
}

/** option creates a select option with a label and a value. */
export function option(label: string, value: string): HTMLOptionElement {
  const made = el("option", "", label);
  made.value = value;
  return made;
}

/**
 * Words records text a component writes once when it is built, so it can be
 * written again when the language changes.
 */
export class Words {
  private readonly writers: Array<() => void> = [];

  /**
   * text sets an element's text from `say`, now and on every write(). Returns
   * the element.
   */
  text<E extends HTMLElement>(el: E, say: () => string): E {
    return this.keep(el, () => (el.textContent = say()));
  }

  /**
   * attr sets an attribute from `say`, now and on every write(). Returns the
   * element.
   */
  attr<E extends HTMLElement>(el: E, name: string, say: () => string): E {
    return this.keep(el, () => el.setAttribute(name, say()));
  }

  /**
   * placeholder sets an input's placeholder from `say`, now and on every
   * write().
   */
  placeholder<E extends HTMLInputElement>(el: E, say: () => string): E {
    return this.keep(el, () => (el.placeholder = say()));
  }

  /** write runs every recorded writer again, in the current language. */
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
 * walk moves focus one step through `controls`, wrapping at the ends, when
 * `stepOf` reads the key as a step. This keeps Tab inside a surface that
 * sits after the page in the document. Returns whether the key was handled.
 */
export function walk(
  e: KeyboardEvent,
  controls: readonly HTMLElement[],
  stepOf: (e: KeyboardEvent) => 1 | -1 | 0 = tabStep,
): boolean {
  const step = stepOf(e);
  if (step === 0) return false;
  e.preventDefault();
  // Focus moves among the enabled controls, so disabled ones are skipped.
  const live = controls.filter((c) => !c.hasAttribute("disabled"));
  // When every control is disabled, the key is left to the page.
  if (live.length === 0) return false;
  const at = live.indexOf(document.activeElement as HTMLElement);
  // From outside the controls, a step forward lands on the first and a step
  // back on the last.
  const from = at >= 0 ? at : step > 0 ? -1 : live.length;
  live[(from + step + live.length) % live.length]?.focus();
  return true;
}

/** tabStep reads Tab as a step forward and Shift+Tab as a step back. */
export function tabStep(e: KeyboardEvent): 1 | -1 | 0 {
  if (e.key !== "Tab") return 0;
  return e.shiftKey ? -1 : 1;
}

/**
 * message returns an error's text: translated when the engine sent it as
 * data, and as written otherwise.
 */
export function message(err: unknown): string {
  return said(err);
}

/**
 * settled returns a trigger that calls `run` once `ms` have passed since
 * the last trigger. Triggers that fire while a run is in flight are ignored.
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

/** baseName returns the last part of a path, with either separator. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * folderName returns the name of the folder a path is in: "exports" for
 * /work/exports/q3.uno.
 */
export function folderName(path: string): string {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return end < 0 ? "" : baseName(path.slice(0, end));
}
