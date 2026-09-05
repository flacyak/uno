package ui

import (
	"errors"
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

// split pairs each formula with the folder it came out of and drops a library
// formula whose id the beside folder also claims.
//
// The beside copy winning is what keeps ids unique in the drawer. Two rows
// under one id would make ColumnFormula.Ref ambiguous the moment either was
// applied, and disambiguating a saved reference would mean moving the .uno
// format to say which folder it meant. Hiding one row costs the person their
// own copy while that tab is in front, and costs the file format nothing.
//
// A beside folder that is the library folder is no beside folder at all. A
// document saved into the formulas directory would otherwise put every formula
// in the beside group and leave the library group empty, which says something
// false about where they live.
func split(beside, lib []library.Formula, besideDir, libDir string) (b, l []sourced) {
	if besideDir == "" || besideDir == libDir {
		beside = nil
	}

	claimed := make(map[string]bool, len(beside))
	for _, f := range beside {
		claimed[f.ID] = true
		b = append(b, sourced{Formula: f, dir: besideDir})
	}
	for _, f := range lib {
		if claimed[f.ID] {
			continue
		}
		l = append(l, sourced{Formula: f, dir: libDir})
	}
	return b, l
}

// sources reads both folders. Two ReadDirs, and only when the drawer asks.
//
// Nothing here happens when a document is opened, which is the point. Opening
// runs before the first frame, on the goroutine that would otherwise be
// drawing it, with no progress shown anywhere; a ReadDir and a parse per
// formula over a network share would be paid there by everyone and noticed by
// nobody. A person cannot tell whether the folder was scanned at launch or at
// the moment they asked for the panel. They can very much tell whether they
// had to go and find the file.
//
// The errors are joined rather than the first one returned, because a bad file
// in one folder says nothing about the other: half the drawer can now have
// arrived from somebody else, and one thing they sent that will not parse
// should cost one formula rather than the panel.
func (s *Shell) sources() (beside, lib []sourced, err error) {
	libDir := s.libraryDir()
	bDir := besideDir(s.active())

	var found []library.Formula
	var besideErr error
	// The same folder is not read twice: split would refuse the second group
	// anyway, and this is the ReadDir that does not happen.
	if bDir != "" && bDir != libDir {
		found, besideErr = library.Load(bDir)
	}

	inLib, libErr := library.Load(libDir)

	beside, lib = split(found, inLib, bDir, libDir)
	return beside, lib, errors.Join(besideErr, libErr)
}
