package ui

import (
	"path/filepath"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/storage"

	"github.com/flacyak/uno/internal/document"
)

// save writes in place once the workspace has a .uno behind it, and falls
// through to Save As when it does not. The two are one intent — put this
// workspace somewhere — and the app works out which one applies.
func (s *Shell) save() {
	w := s.active()
	if w == nil || w.sheet == nil {
		return // an empty workspace has nothing to write
	}
	if w.path == "" {
		s.saveAs()
		return
	}
	s.write(w, w.path)
}

// saveAs always asks, including for a workspace that already has a file.
func (s *Shell) saveAs() {
	w := s.active()
	if w == nil || w.sheet == nil {
		return
	}

	d := dialog.NewFileSave(func(wc fyne.URIWriteCloser, err error) {
		if err != nil {
			dialog.ShowError(err, s.win)
			return
		}
		if wc == nil {
			return // cancelled, so leave the workspace as it is
		}

		// Fyne hands back an already-open writer, but Write needs a path so it
		// can do the temp-and-rename. Take the path and close this immediately
		// rather than streaming a half-built archive into the chosen file.
		path := wc.URI().Path()
		wc.Close()

		s.write(w, path)
	}, s.win)

	d.SetFileName(unoName(w.name)) // sales-q3.csv -> sales-q3.uno
	d.SetFilter(storage.NewExtensionFileFilter([]string{unoExt}))
	d.Show()
}

// write saves a snapshot of the workspace to path.
//
// Deflating a large source and fsyncing it takes long enough to be felt, so it
// runs on a worker over a value the UI goroutine handed over, and the result is
// committed back on the UI goroutine.
func (s *Shell) write(w *workspace, path string) {
	if w.saving {
		return // a second Ctrl+S before the first landed would write it twice
	}
	doc := w.document()
	w.saving = true

	go func() {
		err := document.Write(path, doc)
		fyne.Do(func() { s.wrote(w, path, doc, err) })
	}()
}

// wrote lands a finished save back on the UI goroutine. It takes the document
// the worker wrote rather than reading the workspace again, because the
// workspace may have moved on while the file was being written.
func (s *Shell) wrote(w *workspace, path string, doc *document.Document, err error) {
	w.saving = false
	if err != nil {
		dialog.ShowError(err, s.win)
		return
	}

	w.path = path
	w.name = filepath.Base(path)
	// The manifest comes back carrying the timestamps and the hash the writer
	// measured, so the next save preserves the time of the first one.
	w.manifest = doc.Manifest

	// What landed on disk is the log the worker took away, so that is the log the
	// workspace is now measured against. Anything changed while the file was
	// being written is not in it, and is still unsaved.
	w.savedLog = doc.Edits
	s.refreshStatus()
}

const unoExt = ".uno"

func isUno(name string) bool {
	return strings.EqualFold(filepath.Ext(name), unoExt)
}

// unoName swaps the extension rather than appending one, so a first save offers
// sales-q3.uno instead of sales-q3.csv.uno.
func unoName(name string) string {
	return strings.TrimSuffix(name, filepath.Ext(name)) + unoExt
}
