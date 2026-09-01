package ui

import (
	"fmt"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/dialog"
)

// onDropped receives everything the window was given at once. Each file becomes
// its own workspace, so dropping three files lands as three tabs rather than
// three fights over one grid.
//
// The fyne.Position is where the pointer released. uno ignores it: the drop goes
// to the active workspace and its neighbours, not to whichever tab you happened
// to be over.
func (s *Shell) onDropped(_ fyne.Position, uris []fyne.URI) {
	s.report(s.openAll(uris))
}

// openAll opens each URI it can and names the ones it could not, rather than
// stopping at the first failure: nine good files in a drop are still nine files.
func (s *Shell) openAll(uris []fyne.URI) []string {
	var failed []string
	for _, u := range uris {
		// A drag can carry text or a web URL. Those are not ours to open, and
		// silently skipping them is friendlier than an error nobody asked for.
		if u.Scheme() != "file" {
			continue
		}
		if err := s.openURI(u); err != nil {
			failed = append(failed, u.Name())
		}
	}
	return failed
}

// report raises one dialog for a whole batch. Twelve files with two bad ones
// should open ten workspaces and raise a single complaint naming the two.
func (s *Shell) report(failed []string) {
	if len(failed) == 0 {
		return
	}
	dialog.ShowError(
		fmt.Errorf("could not open %s", strings.Join(failed, ", ")),
		s.win,
	)
}
