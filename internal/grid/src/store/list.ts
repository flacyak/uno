// Browsing a place files are, as its own interface.
//
// `FileHandler` claims a ref and opens it, and that is all it does. Browsing is
// separate because not every place a file can be has anything to browse: a Blob
// dropped into a page is a file and nothing around it. A provider that can do
// both -- a disk, a bucket -- supplies one of each, and the two never depend on
// one another.
//
// Nothing here reads anything. It is the shape a lister has; the reading lives
// in store/disklister.ts and store/s3.ts, the refusal when no lister claims a
// path is store/claim.ts, and what plugs the two interfaces in as one thing is
// the plugin package.

import { BROWSES, claim } from "./claim.ts";

/**
 * Entry is one thing a listing found.
 *
 * A folder is a prefix to list next and a file is a ref to open, which is why
 * `path` is what a FileRef would carry -- /home/jo/q3.csv, s3://bucket/key --
 * rather than a name to join onto something. A caller that wants to open an
 * entry already holds everything openWith needs.
 *
 * The three optional fields are optional because a listing is not a stat: S3
 * gives size and ETag away in ListObjectsV2 and a disk gives them for the cost
 * of a stat per entry, but a prefix has none of them and neither does a place
 * that only knows its own names.
 */
export interface Entry {
  name: string;
  /** What a FileRef would carry: /home/…/a.csv, s3://bucket/key. */
  path: string;
  folder: boolean;
  bytes?: number;
  modified?: Date;
  /** ETag, or S3 VersionId when the bucket keeps versions. */
  version?: string;
}

/**
 * Listing is one page of a folder or a prefix.
 *
 * It is a page and never the whole, because the prefix somebody browses into
 * may hold two entries or two million and the panel that draws it cannot tell
 * which until it asks. Entries come back folders first and then by name, so the
 * order is the same whatever answered.
 */
export interface Listing {
  entries: Entry[];
  /** Where the next page starts, when there is one. Absent at the end. */
  next?: string;
}

/**
 * Lister browses one kind of place: a disk, a bucket, later a GCS or Azure
 * container.
 *
 * `handles` looks at the path and nothing else, the way a handler's does, so
 * the engine can pick a lister for a prefix it read out of a .uno without
 * asking anybody.
 *
 * `stat` is deliberately not `list` of one entry. It is what "newer in the
 * bucket than in this workspace" is decided from, it costs one HEAD, and it has
 * to stay that cheap because a workspace with forty sources asks it forty times
 * on open.
 */
export interface Lister {
  /** What a person would call this kind of place, for an error that names it. */
  readonly label: string;
  /** Whether `path` is one this lister browses. */
  handles(path: string): boolean;
  /** One page from `cursor`, or the first page when there is none. */
  list(path: string, cursor?: string): Promise<Listing>;
  /** Size and version now, without reading the file. */
  stat(path: string): Promise<Entry>;
}

/**
 * listWith lists a path through the first lister that claims it.
 *
 * It refuses by name for the same reason openWith does: a workspace written on
 * a machine with S3 set up, opened on one without, has to say which kind of
 * place it cannot reach rather than showing an empty folder, which is a
 * different and much quieter lie than an empty file.
 */
export async function listWith(
  listers: readonly Lister[],
  path: string,
  cursor?: string,
): Promise<Listing> {
  return claim(listers, path, (l) => l.handles(path), BROWSES).list(path, cursor);
}

/**
 * statWith asks the first lister that claims a path for size and version,
 * refusing by name the same way listWith does.
 *
 * It is here beside listWith rather than inlined by the one caller because a
 * path that cannot be browsed cannot be statted either, and the two have to
 * say so in the same words.
 */
export async function statWith(listers: readonly Lister[], path: string): Promise<Entry> {
  return claim(listers, path, (l) => l.handles(path), BROWSES).stat(path);
}
