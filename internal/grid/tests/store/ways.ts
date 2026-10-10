// The ways out of the core (the disk, the network, a program) and the src/
// modules allowed to take each one.
//
// opens.test.ts checks the source text against this list. reaches.test.ts
// runs the core and checks what it reached against the same list.

export type Way =
  | "the disk"
  | "fetch"
  | "a program"
  | "a Blob's bytes"
  | "a socket"
  | "a page's own requests";

/**
 * The modules allowed each way out, as paths under src/. A lister is allowed
 * the same reads as its handler. Where a handler and its lister are two
 * files, both are named.
 */
export const PLACES: Record<Way, readonly string[]> = {
  // The local file handler, the store's write, and the disk lister.
  "the disk": ["store/node.ts", "store/disklister.ts"],
  // The S3 handler and lister, and the SSO portal and STS exchanges.
  fetch: ["store/s3.ts", "store/sts.ts"],
  // A profile's credential_process.
  "a program": ["store/node.ts"],
  // The blob handler.
  "a Blob's bytes": ["store/index.ts"],
  // Every module is barred from a socket, a server, and a page request.
  "a socket": [],
  "a page's own requests": [],
};

/** The Node modules each way is reached through, as bare names. */
export const MODULES: Partial<Record<Way, readonly string[]>> = {
  "the disk": ["fs", "fs/promises"],
  "a program": ["child_process"],
  "a socket": ["net", "http", "https", "http2", "dgram", "tls", "dns", "worker_threads", "cluster"],
};

/** Every use outside its allowed places, as `file: way`, sorted. */
export function offences(uses: Iterable<{ file: string; way: Way }>): string[] {
  const found = new Set<string>();
  for (const { file, way } of uses) {
    if (!PLACES[way].includes(file)) found.add(`${file}: ${way}`);
  }
  return [...found].sort();
}
