package ui

import (
	"path/filepath"

	"github.com/flacyak/uno/internal/library"
)

// sourced is a formula and the directory it came out of. library.Formula
// deliberately carries no path -- a formula that only worked where it was
// written is not shareable -- so where to write it back is kept beside it
// rather than in it.
type sourced struct {
	library.Formula
	dir string
}

// besideDir is the folder the active document is sitting in, or "" when it is
// not sitting in one. A CSV opened through the dialog has no path: load takes
// a name and a reader, and the directory is already gone by then.
//
// It is computed from the active tab at the moment it is wanted and never
// held, which is what keeps a folder read for one workspace from being shown
// beside another one's rows (I-3). It is also a string and not a read: the
// folder is named here and opened by internal/library, so the panel stays
// testable with no display and no filesystem behind it (I-6).
func besideDir(w *workspace) string {
	if w == nil || w.path == "" {
		return ""
	}
	return filepath.Dir(w.path)
}
