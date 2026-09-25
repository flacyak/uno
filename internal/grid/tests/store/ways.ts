// The ways out of the core -- a disk, a network, a program -- and the only
// modules of src/ allowed to take each one.
//
// Two guards read this. opens.test.ts reads the source as text, which catches
// a way out wherever it is written, including in code no test runs.
// reaches.test.ts runs the core and watches, which catches a way out however
// it is reached for, including a module name put together at run time. Each
// covers what the other cannot, and both hold the core to this one list.

export type Way =
  | "the disk"
  | "fetch"
  | "a program"
  | "a Blob's bytes"
  | "a socket"
  | "a page's own requests";

/**
 * Where each way out is allowed: inside a handler, the lister beside it, or
 * the exchange that turns a sign-in into keys, and nowhere else. Paths are
 * under src/.
 *
 * A lister is allowed exactly the reads its handler is, because they reach
 * the same place. The list names modules and not interfaces, so where the two
 * are one file it holds one name and where they are split -- the disk's are --
 * it holds both.
 */
export const PLACES: Record<Way, readonly string[]> = {
  // The local handler's descriptor and the store's atomic write, and beside
  // them the disk lister's readdir and stat.
  "the disk": ["store/node.ts", "store/disklister.ts"],
  // The S3 handler's requests, and through them the S3 lister's
  // ListObjectsV2. Beside them, the exchanges that turn a sign-in into keys:
  // the SSO portal and STS.
  fetch: ["store/s3.ts", "store/sts.ts"],
  // A profile's credential_process, which is the one program uno runs.
  "a program": ["store/node.ts"],
  // The blob handler.
  "a Blob's bytes": ["store/index.ts"],
  // Every other way to a network or a process, which nothing in the core
  // takes: a socket, a server, a name lookup, a worker's own requests.
  "a socket": [],
  "a page's own requests": [],
};

/** The Node modules each way is reached through, by name without `node:`. */
export const MODULES: Partial<Record<Way, readonly string[]>> = {
  "the disk": ["fs", "fs/promises"],
  "a program": ["child_process"],
  "a socket": ["net", "http", "https", "http2", "dgram", "tls", "dns", "worker_threads", "cluster"],
};

/** Every way used outside its places, as `file: way`, sorted. */
export function offences(uses: Iterable<{ file: string; way: Way }>): string[] {
  const found = new Set<string>();
  for (const { file, way } of uses) {
    if (!PLACES[way].includes(file)) found.add(`${file}: ${way}`);
  }
  return [...found].sort();
}
