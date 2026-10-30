/**
 * @fileoverview Path helpers for the source paths a .uno stores.
 *
 * A source under the workspace's folder is stored relative to that folder.
 * Any other source is stored absolute. A relative path always descends from
 * the folder, so `against` is a plain concatenation and every path passes
 * through as written. A dataset's parts are all under its root, so each is
 * stored relative to the root and joined back onto it, whatever it looks
 * like.
 *
 * This runs in the browser too, so it uses string operations only.
 */

import { isRemote } from '@store';

/** Matches either separator. A .uno written on Windows opens on Linux. */
const SEP = /[/\\]/;

/** Matches the one separator of a URL such as s3://bucket/key, where a
 * backslash is part of the key. */
const URL_SEP = /\//;

/** The segments that name a folder from the one they are in rather than
 * descend from it. */
const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);

/** isAbsolute is true for a POSIX path, a Windows drive path, a UNC share or
 * a URL such as s3://bucket/key. */
export function isAbsolute(path: string): boolean {
  return /^[/\\]/.test(path) || /^[A-Za-z]:[/\\]/.test(path) || isRemote(path);
}

/** dirOf returns the folder part of a path, or "" for a bare name. */
export function dirOf(path: string): string {
  const cut = lastSep(path);
  return cut < 0 ? '' : path.slice(0, cut);
}

/** baseOf returns the file name part of a path. */
export function baseOf(path: string): string {
  return path.slice(lastSep(path) + 1);
}

/**
 * relativeTo returns where `file` sits under `dir`, with forward slashes, or
 * as the rest of its key when `dir` is a URL. A file in a sibling folder, on
 * another drive or above `dir` gives "". The result is a plain descent from
 * `dir`. `dir` may end in its separator, as a bucket prefix such as
 * s3://lake/orders/ does.
 */
export function relativeTo(file: string, dir: string): string {
  const rest = descent(file, dir);
  // `against` hands back a path that looks absolute as it is, so a doubled
  // separator or a drive-like segment would not find `file` again.
  return isAbsolute(rest) ? '' : rest;
}

/**
 * against resolves a stored path from `dir`. An absolute path is returned as
 * is. A relative path is joined onto `dir`. When `dir` is "" a relative path
 * is returned unchanged.
 */
export function against(stored: string, dir: string): string {
  if (stored === '' || dir === '' || isAbsolute(stored)) return stored;
  return joined(dir, stored);
}

/**
 * underRoot returns where `file` sits under a dataset's `root`, as uno.json
 * stores a part's path, or "" when it is not under the root. Under a bucket
 * prefix such as s3://lake/orders/ it is the rest of the key, as written.
 */
export function underRoot(file: string, root: string): string {
  return descent(file, root);
}

/**
 * onRoot resolves a part's path stored under `root`. Every part is under its
 * root, so the path is joined onto the root however it starts.
 */
export function onRoot(stored: string, root: string): string {
  return joined(root, stored);
}

/**
 * samePath is true when two paths are the same text, treating both
 * separators alike. Case, dot segments and symlinks compare as written.
 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

function lastSep(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/**
 * descent returns the rest of `file` after `dir` and a separator, or "" when
 * `file` is not a plain descent from `dir`: in a sibling folder, on another
 * drive, `dir` itself, or through a '.' or '..' segment. On disk either
 * separator counts and the rest has forward slashes. Under a URL such as
 * s3://lake/orders/, '/' is the only separator and the rest of a key is kept
 * as written. `dir` may end in its separator.
 */
function descent(file: string, dir: string): string {
  if (dir === '' || file === '') return '';
  // Where `dir` ends without its separator, which `file` must have next.
  const end = endsInSep(dir) ? dir.length - 1 : dir.length;
  if (file.slice(0, end) !== dir.slice(0, end)) return '';
  if (!separatorOf(dir).test(file.charAt(end))) return '';
  const rest = file.slice(end + 1);
  const forward = isRemote(dir) ? rest : rest.replace(/\\/g, '/');
  // '..' climbs out of `dir`, on disk and in a URL alike.
  return forward.split('/').some((s) => DOT_SEGMENTS.has(s)) ? '' : forward;
}

/** joined puts `rest` under `dir`, with a separator between unless `dir`
 * ends in one. */
function joined(dir: string, rest: string): string {
  return dir + (endsInSep(dir) ? '' : '/') + rest;
}

/** separatorOf matches what separates the folders of `path`: '/' alone in a
 * URL, and either separator otherwise. */
function separatorOf(path: string): RegExp {
  return isRemote(path) ? URL_SEP : SEP;
}

/** endsInSep is true when `path` ends in its separator, as a bucket prefix
 * does. */
function endsInSep(path: string): boolean {
  return separatorOf(path).test(path.charAt(path.length - 1));
}
