// Go's bytes package, where JavaScript has no function for the same thing.

/**
 * concat is `bytes.Join(pieces, nil)`: one array holding every piece in turn.
 *
 * A reader hands back what it read in pieces, and a file, a body or a chunk of
 * a zip wants them whole. One copy, sized once, is what each of those wrote
 * before this was shared.
 */
export function concat(pieces: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
