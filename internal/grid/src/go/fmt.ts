// The two fmt verbs the core's error messages depend on.

/**
 * formatU is `%U`: `U+221A`.
 *
 * `notation` uses it to name a symbol the font cannot draw, deliberately
 * without printing the character -- an error message showing a tofu box says
 * nothing about which symbol was refused.
 */
export function formatU(r: string): string {
  const cp = r.codePointAt(0) ?? 0;
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}
