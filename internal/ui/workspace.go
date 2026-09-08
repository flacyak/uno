package ui

import (
	"bytes"
	"fmt"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/document"
	"github.com/flacyak/uno/internal/ingest"
	"github.com/flacyak/uno/internal/pattern"
	"github.com/flacyak/uno/internal/sheet"
)

// A workspace is one open file: one tab, one sheet, one grid, one .uno (I-3).
// It is also the blast radius. The edit log hangs off the sheet this struct
// owns, so a change made in one file can never reach another.
type workspace struct {
	sheet  *sheet.Sheet
	table  *grid
	editor *widget.Entry
	tab    *container.TabItem

	// inline is the editor that appears in the grid itself, inlineIn the cell
	// holding it, and editing whether it is in the grid at all. Which cell it is
	// in is not a fourth piece of state: only the selected cell is ever edited,
	// so active already says.
	inline   *inlineEntry
	inlineIn *cell
	editing  bool

	// proposal is what the recogniser last found here, and nil when it found
	// nothing or the log has moved on. The bar that asks about it belongs to the
	// shell, because only the selected tab is being looked at; what the question
	// is about stays here, so nothing about one file reaches another (I-3).
	proposal *pattern.Proposal

	// formulaRefs says which .unof each bound column came from, so edit beside a
	// name can find it again. It is a convenience and never a dependency: the
	// expression itself is in the log, so a file whose references resolve to
	// nothing still computes (I-4).
	formulaRefs map[int]string

	// dismissed remembers, per column, the program the person said no to. Keyed
	// by the program and not only by the column, so refusing one offer does not
	// silence a column for the session: a better question about it is a
	// different question.
	dismissed map[int]string

	// raw is the bytes uno was handed, kept for as long as the workspace is
	// open. They are authoritative (I-4): the .uno stores them verbatim, and
	// replay rebuilds the sheet from them rather than from a rewritten copy.
	raw []byte

	// name is what the tab says: the .uno's name once saved, and the source
	// file's before that. It is not sheet.Name, which stays the name of the file
	// the bytes came from so ingest keeps choosing the same decoder for them.
	name string

	// path is the .uno this workspace writes to. Empty until the first save,
	// which is what makes Ctrl+S fall through to Save As.
	path string

	// manifest carries provenance across saves: the source name it was opened
	// from, and the time it was first written.
	manifest document.Manifest

	// extra holds entries a newer uno wrote that this build did not recognise,
	// so saving carries them through rather than dropping them.
	extra map[string][]byte

	active document.Cell
	saving bool

	// savedLog is the log as it was written to the file on disk, and nil for a
	// workspace that has never been saved. Holding it is what lets undo take the
	// dot back off: the workspace is clean whenever what it holds is what was
	// written, however it got back there.
	savedLog []sheet.Edit
}

// dirty reports whether this workspace holds changes no file has.
func (w *workspace) dirty() bool {
	return w.sheet != nil && !w.sheet.LogEquals(w.savedLog)
}

// newWorkspace builds an empty workspace showing the drop target. It gets its
// real name when a file lands in it.
func (s *Shell) newWorkspace() *workspace {
	w := &workspace{name: untitled(len(s.tabs.Items) + 1)}
	w.tab = container.NewTabItem(w.name, s.emptyState())
	s.byTab[w.tab] = w
	return w
}

func untitled(n int) string { return fmt.Sprintf("Untitled %d", n) }

// fill swaps a loaded sheet into this workspace and replaces the drop target
// with the grid. Nothing outside the workspace sees the sheet until this
// returns, so a failed load leaves the previous content untouched.
//
// The caller sets name, path, manifest, extra and active first: this builds
// what those describe.
func (s *Shell) fill(w *workspace, sh *sheet.Sheet, raw []byte) {
	w.sheet = sh
	w.raw = raw
	w.editor = s.newEditor(w)

	// The grid's cells reach for the inline editor as they are built, so it has
	// to exist before the table does.
	w.inline, w.inlineIn, w.editing = s.newInline(w), nil, false
	w.table = s.newTable(w)
	w.proposal, w.dismissed = nil, map[int]string{}

	w.table.OnSelected = func(id widget.TableCellID) {
		if id.Row < 0 || id.Col < 0 {
			return // a header is not a cell anyone edits
		}
		w.active = document.Cell{Row: id.Row, Col: id.Col}
		w.showActive()
		s.refreshStatus()
	}

	// The editor bar sits above the grid, which is the one place a value too
	// wide for its column is still readable in full.
	w.tab.Content = container.NewBorder(w.editor, nil, nil, nil, w.table)
	w.tab.Text = w.name

	// Selecting through the table rather than assigning w.active is what puts
	// the highlight, the editor and the cell reference in the same state a click
	// would leave them in.
	if sh.Rows() > 0 && sh.Cols() > 0 {
		w.table.Select(widget.TableCellID{
			Row: clampIndex(w.active.Row, sh.Rows()),
			Col: clampIndex(w.active.Col, sh.Cols()),
		})

		// Select scrolls to what it selected, and here it is doing that
		// arithmetic against a table with no size yet, so the offset it lands on
		// means nothing. A freshly opened workspace shows the start of its file.
		// Coming back to where the view sat is a separate promise, and it needs
		// a scroll position stored as a row identity rather than as an offset.
		w.table.ScrollToTop()
		w.table.ScrollToLeading()

		// A file that has just opened has a cell chosen and nothing else worth
		// typing into, so the grid takes the keyboard: without this the arrows
		// and Enter do nothing until something has been clicked, which makes the
		// keyboard a thing you reach by using the mouse first.
		s.focus(w.table)
	}

	// A .uno reopened part-way through fixing a column arrives with the examples
	// already in its log, and the question is as worth asking on Monday as it
	// was on Friday.
	s.rescan(w)
}

// newEditor is the cell editor: one field, not a widget per cell. The grid keeps
// recycling plain labels, so its update closure stays the allocation-free read
// that I-1 promises however much of the sheet is being edited.
func (s *Shell) newEditor(w *workspace) *widget.Entry {
	e := widget.NewEntry()
	e.SetPlaceHolder("Select a cell, then type here and press Enter")
	e.OnSubmitted = func(text string) { s.commit(w, text) }
	return e
}

// commit writes what was typed into the selected cell, through sheet.Set so the
// change is logged as it is made. Retyping the value already there is not an
// edit and must not add a line to the log.
func (s *Shell) commit(w *workspace, text string) {
	if w.sheet == nil || text == w.sheet.Raw(w.active.Row, w.active.Col) {
		return
	}

	before := w.sheet.Columns[w.active.Col]
	if err := w.sheet.Set(w.active.Row, w.active.Col, text); err != nil {
		dialog.ShowError(err, s.win)
		return
	}

	// One cell changed, so one cell is redrawn. A column that changed kind
	// changed its badge as well, and that badge lives in the header.
	if w.sheet.Columns[w.active.Col] != before {
		w.table.Refresh()
	} else {
		w.table.RefreshItem(widget.TableCellID{Row: w.active.Row, Col: w.active.Col})
	}
	w.showActive()
	s.rescan(w) // this edit is the evidence the recogniser learns from
	s.refreshStatus()
}

// showActive points the editor bar at the selected cell. Every path that changes
// which cell that is, or what is in it, ends here, so the bar and the grid
// cannot drift apart.
//
// Raw and not Display: the bar is where a cell is edited, and what you edit is
// what the cell stores. The grid is the only thing bound to Display.
func (w *workspace) showActive() {
	w.editor.SetText(w.sheet.Raw(w.active.Row, w.active.Col))
}

// inlineEntry is the grid's cell editor. It is a plain Entry apart from Escape:
// Fyne's Entry ignores that key, and an editor opened by a stray click needs a
// way out that writes nothing.
type inlineEntry struct {
	widget.Entry
	cancel func()
}

func (s *Shell) newInline(w *workspace) *inlineEntry {
	e := &inlineEntry{cancel: func() { s.endEdit(w, false) }}
	e.ExtendBaseWidget(e)
	e.OnSubmitted = func(string) { s.endEdit(w, true) }
	return e
}

func (e *inlineEntry) TypedKey(k *fyne.KeyEvent) {
	if k.Name == fyne.KeyEscape {
		e.cancel()
		return
	}
	e.Entry.TypedKey(k)
}

// tapCell is a click on a square of the grid. The first click chooses the cell,
// which is all a click has ever done; a second click on the cell already chosen
// opens it for typing, so the fix happens where the value is rather than at the
// top of the window. Double-click would be the more familiar gesture and cannot
// be the one: Fyne delays every single tap on a double-tappable object while it
// waits to see whether a second one is coming, and that delay is on the plain
// selection click, which is the one uno does most.
func (s *Shell) tapCell(w *workspace, id widget.TableCellID) {
	if w.sheet == nil {
		return
	}
	if w.active == (document.Cell{Row: id.Row, Col: id.Col}) {
		s.beginEdit(w)
		return
	}

	// Clicking off a cell keeps what was typed into it, the way a spreadsheet
	// does. Selecting is what then repoints active, the bar and the status.
	s.endEdit(w, true)
	w.table.Select(id)

	// widget.Table focuses itself when it handles a tap, and it did not handle
	// this one. Without this, giving a cell its own click would quietly cost the
	// grid the keyboard.
	s.focus(w.table)
}

// beginEdit puts the inline editor into the selected cell, carrying the value
// already there so correcting one character is not retyping the whole field.
func (s *Shell) beginEdit(w *workspace) {
	if w.sheet == nil || w.editing || w.sheet.Rows() == 0 {
		return
	}
	w.editing = true
	w.inline.SetText(w.sheet.Raw(w.active.Row, w.active.Col))
	w.table.RefreshItem(widget.TableCellID{Row: w.active.Row, Col: w.active.Col})
	s.focus(w.inline)
}

// endEdit takes the inline editor back out of the grid. keep says whether what
// is in it is worth anything: Enter and a click on another cell keep it, Escape
// does not. Committing goes through the same commit the editor bar uses, so a
// value typed in the grid is logged exactly like one typed at the top.
func (s *Shell) endEdit(w *workspace, keep bool) {
	if !w.editing {
		return
	}
	text := w.inline.Text
	w.editing = false
	w.table.RefreshItem(widget.TableCellID{Row: w.active.Row, Col: w.active.Col})
	s.focus(w.table)

	if keep {
		s.commit(w, text)
	}
}

// focus guards the canvas, which a shell built without one does not have.
func (s *Shell) focus(o fyne.Focusable) {
	if c := s.win.Canvas(); c != nil {
		c.Focus(o)
	}
}

// undo drops the last operation and rebuilds the sheet by replaying what is left
// over the raw bytes.
//
// Rebuilding rather than putting the old value back is what makes undo survive a
// save: a file closed on Friday still undoes on Monday, because the raw bytes
// and the log travel in the .uno and nothing about undo was ever held in memory.
// It is also the only mechanism that stays right once one operation covers
// thousands of rows and has no old value to put back.
func (w *workspace) undo() error {
	edits := w.sheet.Edits()

	sh, err := ingest.Read(w.sheet.Name, bytes.NewReader(w.raw))
	if err != nil {
		return err
	}
	if err := sh.Replay(edits[:len(edits)-1]); err != nil {
		return err
	}

	// Only a rebuild that got all the way here replaces what is on screen.
	w.sheet = sh
	return nil
}

// document snapshots the workspace as a value the writer can take away. The raw
// bytes are immutable and everything else is copied here, so the deflate and the
// fsync run on a worker goroutine while the person carries on typing (I-7). The
// grid's dimensions are read here for the same reason: they are the one thing
// the manifest states that the writer cannot measure for itself.
func (w *workspace) document() *document.Document {
	m := w.manifest
	m.Sheet.Rows, m.Sheet.Cols = w.sheet.Rows(), w.sheet.Cols()

	return &document.Document{
		Manifest: m,
		Raw:      w.raw,
		State: document.State{
			Active:         w.active,
			ColumnFormulas: w.columnFormulas(),
		},
		Edits: w.sheet.Edits(),
		Extra: w.extra, // replaced wholesale on open, never written into
	}
}

// columnFormulas is the library reference for each bound column, in column
// order so two saves of an unchanged workspace produce the same bytes.
//
// A column with no reference is simply absent. That is the ordinary case for a
// file someone else bound and sent, and it is not a gap to be filled in: the
// expression is in the log, and the reference is only ever how the drawer finds
// the formula again on the machine it was written on.
func (w *workspace) columnFormulas() []document.ColumnFormula {
	if len(w.formulaRefs) == 0 {
		return nil
	}
	out := make([]document.ColumnFormula, 0, len(w.formulaRefs))
	for col := 0; col < w.sheet.Cols(); col++ {
		if ref, ok := w.formulaRefs[col]; ok {
			out = append(out, document.ColumnFormula{Col: col, Ref: ref})
		}
	}
	return out
}

func clampIndex(i, n int) int {
	if i < 0 || i >= n {
		return 0
	}
	return i
}

// emptyState is the dashed drop target. It is a standing affordance, not a
// hover state: the window API hands us the drop, not the drag-over, so there is
// no event to light a border up with while a file is held over the window.
func (s *Shell) emptyState() fyne.CanvasObject {
	title := widget.NewLabelWithStyle("Drop a data file here", fyne.TextAlignCenter,
		fyne.TextStyle{Bold: true})
	blurb := widget.NewLabelWithStyle(
		"uno reads it from disk and keeps it there. Nothing leaves this machine.",
		fyne.TextAlignCenter, fyne.TextStyle{})
	exts := widget.NewLabelWithStyle(".csv  .tsv  .json  .uno", fyne.TextAlignCenter,
		fyne.TextStyle{Monospace: true})

	btn := widget.NewButtonWithIcon("Open…", theme.FolderOpenIcon(), s.chooseFile)
	btn.Importance = widget.HighImportance

	return container.NewCenter(container.NewVBox(
		title,
		blurb,
		container.NewHBox(layout.NewSpacer(), btn, layout.NewSpacer()),
		exts,
	))
}
