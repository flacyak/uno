package ui

import (
	"bytes"
	"io"
	"path/filepath"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/storage"

	"github.com/flacyak/uno/internal/document"
	"github.com/flacyak/uno/internal/ingest"
)

// load is the door every data file comes through. Menu, shortcut,
// drag-and-drop and a command-line argument all arrive here, so there is exactly
// one place that decides which workspace receives the sheet. It returns the
// error instead of showing it, because a twelve-file drop wants one dialog, not
// twelve.
//
// The bytes are kept, not streamed past: they are what a .uno stores and what
// replay rebuilds from, so a workspace that could not produce them again could
// not be saved (I-4).
func (s *Shell) load(name string, r io.Reader) error {
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	sh, err := ingest.Read(name, bytes.NewReader(raw))
	if err != nil {
		return err // the active tab keeps whatever it had
	}

	w := s.target()
	w.name = name
	w.manifest = document.Manifest{Source: document.Source{Name: name}}

	s.fill(w, sh, raw)
	s.tabs.Select(w.tab)
	s.refreshStatus()
	return nil
}

// openDocument restores a whole saved workspace rather than decoding into the
// active one, which is why a .uno branches above ingest. A container is not a
// dialect of CSV: sniffing a delimiter inside a zip would find one, and that is
// exactly the near-miss that produces a confusing grid instead of a clear error.
func (s *Shell) openDocument(path string) error {
	doc, err := document.Read(path)
	if err != nil {
		return err
	}

	w := s.target()
	w.name = filepath.Base(path)
	w.path = path
	w.manifest = doc.Manifest
	w.extra = doc.Extra
	w.active = doc.State.Active
	w.formulaRefs = refsByColumn(doc.State.ColumnFormulas)
	w.savedLog = doc.Edits // what is in the file, so a fresh open is clean

	s.fill(w, doc.Sheet, doc.Raw)
	s.tabs.Select(w.tab)
	s.refreshStatus()
	return nil
}

// refsByColumn turns the saved list back into the lookup the drawer uses. A
// reference that names a formula this machine does not have is kept rather than
// dropped, so saving the file again does not quietly strip what the sender knew
// about it.
func refsByColumn(list []document.ColumnFormula) map[int]string {
	if len(list) == 0 {
		return nil
	}
	out := make(map[int]string, len(list))
	for _, cf := range list {
		out[cf.Col] = cf.Ref
	}
	return out
}

// target is the workspace an opened file lands in: the active one while it is
// still untouched, so opening from a fresh window does not strand an empty
// "Untitled 1" beside it, and a new tab otherwise.
func (s *Shell) target() *workspace {
	if w := s.active(); w != nil && w.sheet == nil {
		return w
	}
	w := s.newWorkspace()
	s.tabs.Append(w.tab)
	return w
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

// openURI is where the two kinds of file part company, and the only place that
// decides which is which.
//
// It also exists so the reader's lifetime ends with this call. Writing
// `defer rc.Close()` inside the drop loop would keep every dropped file open
// until the entire drop finished. Fine for three files, a descriptor leak for
// three hundred.
func (s *Shell) openURI(u fyne.URI) error {
	if isUno(u.Name()) {
		// A zip is read by seeking around its central directory, so this one
		// needs a path rather than the stream every other format takes.
		return s.openDocument(u.Path())
	}

	rc, err := storage.Reader(u)
	if err != nil {
		return err
	}
	defer rc.Close()

	return s.load(u.Name(), rc)
}

// chooseFile runs the open dialog. Fyne hands back a reader that is already
// open, and it is closed unread: a .uno cannot be loaded from a stream, so the
// URI goes through openURI like every other way of asking for a file.
func (s *Shell) chooseFile() {
	d := dialog.NewFileOpen(func(rc fyne.URIReadCloser, err error) {
		if err != nil {
			dialog.ShowError(err, s.win)
			return
		}
		if rc == nil {
			return // cancelled, so leave the workspace as it is
		}
		u := rc.URI()
		rc.Close()

		if err := s.openURI(u); err != nil {
			dialog.ShowError(err, s.win)
		}
	}, s.win)

	d.SetFilter(storage.NewExtensionFileFilter([]string{".uno", ".csv", ".tsv", ".json"}))
	d.Show()
}
