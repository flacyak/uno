// What every part of the shell reaches for: an element the markup promised, and
// an error as something to say.

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

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
