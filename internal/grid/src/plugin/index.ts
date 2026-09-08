// Package plugin is how a kind of place gets plugged into uno.
//
// `store` holds the two interfaces and the seam they guard: a FileHandler
// opens, a Lister browses, and nothing else reaches a disk or a network. This
// package sits above that and does the one thing neither interface can do for
// itself -- put them together.
//
// They are two interfaces because they are two capabilities and not everywhere
// has both: a Blob dropped into a page can be opened and has nothing to look
// in. They are not two decisions. Whoever can open s3:// is whoever can browse
// it, and a platform that wires the handler and forgets the lister has built a
// bucket you can read from and cannot look inside. So a platform registers
// providers, and the handler list and the lister list are derived from them
// and cannot drift.
//
// It is its own package rather than another file in store/ because the
// dependency runs one way and should be visible: plugin knows what a store is,
// and store has never heard of one. The three references the other way are
// `import type { Provider }`, which is erased before anything runs, so a
// provider factory can live beside the transport it wraps -- which is what
// keeps node:fs and the signing code where they are.
//
// This package is scanned by the guard test in tests/store/opens.test.ts like
// every other module under src/, and is allowed no read of its own: composing
// handlers is all it does.
//
// Deliberately not a registry that modules add themselves to on import. What a
// build can reach stays a list written at the top of a platform: that is what
// makes "this build reads local files" a true sentence, and what keeps
// store/node.ts out of a browser bundle and the S3 signing code out of a build
// that never signs.

import type { ByteSource, Entry, FileHandler, FileRef, Lister, Listing } from "../store/index.ts";
import { listWith, openWith, statWith } from "../store/index.ts";

/**
 * Provider is one kind of place files are: a disk, a bucket, bytes in hand.
 *
 * `browse` is optional because browsing is the capability that can be missing.
 * A Blob has no folder it came from and no path to name one with, so there is
 * nothing a person could look in; answering that with an empty listing would
 * be a quieter lie than saying this kind of place has nothing to browse.
 *
 * A provider is built by the module that owns the transport -- `diskProvider`
 * in store/node.ts, `s3Provider` in store/s3.ts -- and never here. That is what
 * keeps this package free of node:fs and of the signing code, so a browser can
 * import it.
 */
export interface Provider {
  /** What a .uno's `provider` field carries: "disk", "s3", later "gcs". */
  readonly name: string;
  /** What a person would call it, for an error that names it. */
  readonly label: string;
  readonly files: FileHandler;
  readonly browse?: Lister;
}

/**
 * Sources is what a platform can reach, and the only thing an engine is handed.
 *
 * The two lists are derived rather than given, so a provider is wired once and
 * "can I open this" and "can I look in here" come from the same decision.
 */
export interface Sources {
  readonly providers: readonly Provider[];
  /** Every provider's handler, in the order the providers were given. */
  readonly files: readonly FileHandler[];
  /** The listers of the providers that have one. */
  readonly browsers: readonly Lister[];
  open(ref: FileRef): Promise<ByteSource>;
  list(path: string, cursor?: string): Promise<Listing>;
  stat(path: string): Promise<Entry>;
}

/**
 * sources plugs providers in, in order.
 *
 * Order is the platform's: the first provider that claims a path gets it, so a
 * stand-in put in front of S3 in a test is reached first without S3 having to
 * know a test exists.
 */
export function sources(providers: readonly Provider[]): Sources {
  const files = providers.map((p) => p.files);
  const browsers = providers.flatMap((p) => (p.browse === undefined ? [] : [p.browse]));

  return {
    providers,
    files,
    browsers,
    open: (ref) => openWith(files, ref),
    list: (path, cursor) => listWith(browsers, path, cursor),
    // stat asks the listers and not the handlers: it is size and version
    // without reading, which is the question "is the bucket's copy newer than
    // this workspace's" and not a small open.
    stat: (path) => statWith(browsers, path),
  };
}
