// Picks the plugin that claims a path or ref, and builds the error when
// none does. Opening and browsing both use it.

/** A plugin with a label, which the error names. */
interface Named {
  readonly label: string;
}

/**
 * Refusal is the two phrases that differ between an open error and a browse
 * error. The rest of the sentence is shared.
 */
export interface Refusal {
  /** What was asked of this build: "opens it", "browses it". */
  cannot: string;
  /** What it can do, before the list of kinds: "reads", "browses". */
  can: string;
}

/** Opening a ref through a FileHandler. */
export const OPENS: Refusal = { cannot: "opens it", can: "reads" };

/** Opening a ref of several files as one. */
export const JOINS: Refusal = { cannot: "opens several files as one", can: "reads" };

/** Browsing a path through a Lister. */
export const BROWSES: Refusal = { cannot: "browses it", can: "browses" };

/**
 * claim returns the first plugin for which `owns` is true. When none is, it
 * throws an error naming `what` and the labels of every plugin given.
 */
export function claim<T extends Named>(
  plugins: readonly T[],
  what: string,
  owns: (plugin: T) => boolean,
  refusal: Refusal,
): T {
  const found = plugins.find(owns);
  if (found !== undefined) return found;

  // An empty plugin list reads as "nothing".
  const kinds = plugins.map((p) => p.label).join(", ");
  throw new Error(
    `${what}: nothing here ${refusal.cannot} · this build ${refusal.can} ${kinds === "" ? "nothing" : kinds}`,
  );
}
