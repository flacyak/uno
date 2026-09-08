// Just enough of a path for a workspace to point at a file.
//
// A .uno that points at its sources has to say where they are, and where a file
// is depends on where the workspace is. A source under the workspace's own
// folder is written down relative to it, so copying that folder to another
// machine -- or to a share, or onto a stick -- moves the data and the pointer
// together. Anything else is written down absolute, because there is nothing
// else true to say about it.
//
// There is no node:path here, and there will not be: everything above `store`
// runs in a browser unchanged, and this is four string operations.
//
// Relative paths written here never begin with `..`, which is what keeps `join`
// to a concatenation. A source outside the workspace's folder is absolute
// instead of being reached for with dots, so nothing here has to normalise a
// path, and a path that came out of a file is never walked back up through the
// filesystem.

/** Separators, both of them, because a .uno written on Windows opens on Linux. */
const SEP = /[/\\]/;

/** isAbsolute covers a POSIX path, a Windows drive path, and a UNC share. */
export function isAbsolute(path: string): boolean {
  return /^[/\\]/.test(path) || /^[A-Za-z]:[/\\]/.test(path);
}

/** dirOf is the folder a file is in, or "" for a bare name. */
export function dirOf(path: string): string {
  const cut = lastSep(path);
  return cut < 0 ? "" : path.slice(0, cut);
}

/** baseOf is the file's own name. */
export function baseOf(path: string): string {
  return path.slice(lastSep(path) + 1);
}

/**
 * relativeTo is where `file` sits under `dir`, with forward slashes, or "" when
 * it does not sit under it at all.
 *
 * "" is the answer for a file in a sibling folder, on another drive, or above
 * the workspace, and the caller writes the absolute path instead. Reaching up
 * with `..` would buy one more layout and cost every reader an opinion about
 * what a path means.
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
 * against is where a stored path points, read from `dir`.
 *
 * An absolute path is itself. A relative one is read from the folder the .uno
 * is in, which is the whole point of storing it that way. With nowhere to read
 * it from -- a browser, which has no folders -- a relative path stays as it is
 * and fails to open under its own name, which is the truthful failure.
 */
export function against(stored: string, dir: string): string {
  if (stored === "" || dir === "" || isAbsolute(stored)) return stored;
  return dir + (SEP.test(dir.charAt(dir.length - 1)) ? "" : "/") + stored;
}

function lastSep(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}
