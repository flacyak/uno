// What every part of the shell reaches for: an element the markup promised, and
// an error as something to say.

import { said } from "../said.ts";

export function must<T>(value: T | null): T {
  if (value === null) throw new Error("the renderer's markup is missing an element it needs");
  return value;
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
