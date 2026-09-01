package ui

import (
	"io"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/storage"

	"github.com/flacyak/uno/internal/ingest"
)

// load is the single door into the app. Menu, shortcut, drag-and-drop and a
// command-line argument all arrive here, so there is exactly one place that
// decides which workspace receives the sheet. It returns the error instead of
// showing it, because a twelve-file drop wants one dialog, not twelve.
func (s *Shell) load(name string, r io.Reader) error {
	sh, err := ingest.Read(name, r)
	if err != nil {
		return err // the active tab keeps whatever it had
	}

	// Reuse the active workspace only while it is still untouched, so opening a
	// file from a fresh window does not strand an empty "Untitled 1" beside it.
	w := s.active()
	if w == nil || w.sheet != nil {
		w = s.newWorkspace()
		s.tabs.Append(w.tab)
	}

	s.setSheet(w, sh)
	s.tabs.Select(w.tab)
	s.refreshStatus()
	return nil
}

// OpenPaths loads files named on the command line, which is how a file-manager
// double-click arrives. Several paths are the same request as a several-file
// drop, so they take the same route and get the same single error dialog.
func (s *Shell) OpenPaths(paths []string) {
	uris := make([]fyne.URI, 0, len(paths))
	for _, p := range paths {
		uris = append(uris, storage.NewFileURI(p))
	}
	s.report(s.openAll(uris))
}

// openURI exists so the reader's lifetime ends with this call. Writing
// `defer rc.Close()` inside the drop loop would keep every dropped file open
// until the entire drop finished. Fine for three files, a descriptor leak for
// three hundred.
func (s *Shell) openURI(u fyne.URI) error {
	rc, err := storage.Reader(u)
	if err != nil {
		return err
	}
	defer rc.Close()

	return s.load(u.Name(), rc)
}

// chooseFile runs the open dialog. Fyne hands back a URIReadCloser that is
// already open, so we never re-resolve the path.
func (s *Shell) chooseFile() {
	d := dialog.NewFileOpen(func(rc fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, s.win)
			return
		}
		if rc == nil {
			return // cancelled, so leave the workspace as it is
		}
		defer rc.Close()

		if err := s.load(rc.URI().Name(), rc); err != nil {
			dialog.ShowError(err, s.win)
		}
	}, s.win)

	d.SetFilter(storage.NewExtensionFileFilter([]string{".csv", ".tsv", ".json"}))
	d.Show()
}
