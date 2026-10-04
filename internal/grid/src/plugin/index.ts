// Package plugin combines providers into the Sources an engine reads from.
//
// `store` defines FileHandler (opens) and Lister (browses). A Provider pairs
// the two, and the handler list and the lister list are derived from the
// provider list. This package imports `store`; store imports only
// `type Provider` from here, which is erased at runtime, so a provider factory
// lives beside its transport (store/node.ts, store/s3.ts).
//
// The guard test in tests/store/opens.test.ts scans this package like every
// other module under src/. Every read goes through a provider.
//
// Each platform lists its providers explicitly; that list is the only
// registry.

import type { ByteSource, Entry, FileHandler, FileRef, Lister, Listing } from "../store/index.ts";
import { listWith, openWith, statWith } from "../store/index.ts";

/**
 * Provider is one kind of place files are: a disk, a bucket, bytes in hand.
 * `browse` is absent for a place that is one file in hand, such as a Blob.
 * Providers are built by the module that owns the transport: `diskProvider`
 * in store/node.ts, `s3Provider` in store/s3.ts.
 */
export interface Provider {
  /** The value a .uno's `provider` field carries: "disk", "s3". */
  readonly name: string;
  /** The human-readable name, for error messages. */
  readonly label: string;
  readonly files: FileHandler;
  readonly browse?: Lister;
}

/**
 * Sources is what an engine is handed: the providers, and the handler and
 * lister lists derived from them.
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
 * sources builds Sources from providers, in order. The first provider that
 * claims a path handles it.
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
    // stat asks the listers: size and version come from a listing.
    stat: (path) => statWith(browsers, path),
  };
}
