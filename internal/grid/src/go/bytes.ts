// Ports of Go's bytes package.

/**
 * concat mirrors `bytes.Join(pieces, nil)`: one array holding every piece in
 * order.
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
