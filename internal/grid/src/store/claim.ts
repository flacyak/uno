// Which plugin a thing belongs to, decided in one place.
//
// Opening and browsing ask the same question -- who here claims this? -- and
// have to give the same answer when nobody does: name the kinds of place this
// build can reach, so a workspace written on a machine with S3 set up and
// opened on one without says which kind it cannot reach rather than "not
// found" or, worse, an empty folder.
//
// Both refusals were written out separately once and had already drifted: one
// of them trailed off after "reads" when the list was empty. There is one of
// them now, and the words each caller wants are the argument.

/** What a plugin has to have to be refused by name: a name. */
interface Named {
  readonly label: string;
}

/**
 * Refusal is the two words that differ between one kind of asking and another.
 * Everything else about the sentence is the same on purpose.
 */
export interface Refusal {
  /** What this build could not do with it: "opens it", "browses it". */
  cannot: string;
  /** What it can do, in front of the list of kinds: "reads", "browses". */
  can: string;
}

/** Opening a ref through a FileHandler. */
export const OPENS: Refusal = { cannot: "opens it", can: "reads" };

/** Browsing a path through a Lister. */
export const BROWSES: Refusal = { cannot: "browses it", can: "browses" };

/**
 * claim picks the first plugin that says `what` is its own, and throws naming
 * the kinds of place this build does reach when none of them does.
 *
 * First and not best: a plugin decides by looking at the path and nothing else,
 * so two that claim the same path are a wiring mistake to be fixed where the
 * list is built, not an ambiguity to be resolved here every time anybody opens
 * a file.
 */
export function claim<T extends Named>(
  plugins: readonly T[],
  what: string,
  owns: (plugin: T) => boolean,
  refusal: Refusal,
): T {
  const found = plugins.find(owns);
  if (found !== undefined) return found;

  // A build with none at all is a real case -- a browser browses nothing until
  // a connection is added -- so it gets a sentence rather than one with a hole
  // at the end of it.
  const kinds = plugins.map((p) => p.label).join(", ");
  throw new Error(
    `${what}: nothing here ${refusal.cannot} · this build ${refusal.can} ${kinds === "" ? "nothing" : kinds}`,
  );
}
