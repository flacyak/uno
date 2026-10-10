// Ports of fmt verbs.

/** formatU mirrors fmt's `%U` verb: "U+221A". */
export function formatU(r: string): string {
  const cp = r.codePointAt(0) ?? 0;
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}
