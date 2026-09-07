// Package safefile writes a file by building a sibling temp file and renaming
// over the target, so an interrupted write loses the new content rather than the
// content already there.
//
// It exists as its own package because two writers need the same guarantee: the
// .uno container, which a person presses Ctrl+S to produce, and a .unof, which
// autosaves on a debounce while they are still typing. Copying fifteen lines of
// safety into the second caller would give the codebase two copies of a promise,
// and the second copy is the one that quietly stops matching the first.
package safefile

import (
	"io"
	"os"
	"path/filepath"
)

// Write calls fn to produce the contents of path.
//
// Everything fn writes goes to a temp file in the same directory, so the rename
// that publishes it stays on one filesystem and stays atomic. A failure anywhere
// — from fn, from the sync, from the rename — leaves the previous file untouched
// and leaves no half-written part behind for the next person to find.
func Write(path string, fn func(io.Writer) error) (err error) {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".uno-*.part")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name()) // a failed write leaves no debris
		}
	}()

	// A temp file is created 0600 because it is a temp file. That is not a
	// decision about the document, which is an ordinary user file.
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}

	if err = fn(tmp); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil { // durable before the swap, not after
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
