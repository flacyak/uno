// Naming a code point without printing it.

/** formatU names a code point the way the Unicode standard does: "U+221A". */
export function formatU(r: string): string {
  const cp = r.codePointAt(0) ?? 0;
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}
