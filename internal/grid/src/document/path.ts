// Path helpers for the source paths a .uno stores.
//
// A source under the workspace's folder is stored relative to that folder.
// Any other source is stored absolute. A relative path always descends from
// the folder, so `against` is a plain concatenation and every path passes
// through as written.
//
// This runs in the browser too, so it uses string operations only.

/** Matches either separator. A .uno written on Windows opens on Linux. */
const SEP = /[/\\]/;

/** isAbsolute is true for a POSIX path, a Windows drive path, a UNC share or
 * a URL such as s3://bucket/key. */
export function isAbsolute(path: string): boolean {
  return /^[/\\]/.test(path) || /^[A-Za-z]:[/\\]/.test(path) || URL_LIKE.test(path);
}

/** A URL scheme of two or more letters, so a drive letter stays a path. */
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/** dirOf returns the folder part of a path, or "" for a bare name. */
export function dirOf(path: string): string {
  const cut = lastSep(path);
  return cut < 0 ? "" : path.slice(0, cut);
}

/** baseOf returns the file name part of a path. */
export function baseOf(path: string): string {
  return path.slice(lastSep(path) + 1);
}

/**
 * relativeTo returns where `file` sits under `dir`, with forward slashes. A
 * file in a sibling folder, on another drive or above `dir` gives "". The
 * result is a plain descent from `dir`.
 */
export function relativeTo(file: string, dir: string): string {
  if (dir === "" || file === "") return "";
  const head = file.slice(0, dir.length);
  const sep = file.charAt(dir.length);
  if (head !== dir || !SEP.test(sep)) return "";
  const rest = file.slice(dir.length + 1);
  return rest === "" ? "" : rest.replace(/\\/g, "/");
}

/**
 * against resolves a stored path from `dir`. An absolute path is returned as
 * is. A relative path is joined onto `dir`. When `dir` is "" a relative path
 * is returned unchanged.
 */
export function against(stored: string, dir: string): string {
  if (stored === "" || dir === "" || isAbsolute(stored)) return stored;
  return dir + (SEP.test(dir.charAt(dir.length - 1)) ? "" : "/") + stored;
}

/**
 * samePath is true when two paths are the same text, treating both
 * separators alike. Case, dot segments and symlinks compare as written.
 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

function lastSep(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}
