package ui

import (
	"fmt"
	"strings"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/formula"
	"github.com/flacyak/uno/internal/library"
	"github.com/flacyak/uno/internal/notation"
)

// autosaveDelay is how long the editor waits after the last keystroke before it
// writes. Short enough that leaving the panel almost never has anything left to
// flush, long enough that typing an expression is one write rather than thirty.
const autosaveDelay = 600 * time.Millisecond

// formulaEditor is one formula, a level deeper in the same panel.
//
// The preview is the reason this is an editor and not a text field. It evaluates
// against the first row as you type, which is how a mistake is caught before it
// is bound to 4,812 of them, and it is the only thing here that could not be
// done in a text editor over the .unof file.
type formulaEditor struct {
	box *fyne.Container

	kind    *widget.RadioGroup
	name    *widget.Entry
	expr    *widget.Entry
	applies *widget.Label
	preview *widget.Label
	foot    *widget.Label

	// editing is the formula being written, kept in step with the fields on
	// every keystroke. Its ID is fixed when it is created, because the ID is the
	// file name and a rename that moved the file would leave the old one behind.
	//
	// It carries the folder it was opened out of as well as the formula, so a
	// save writes the file that was edited rather than a copy of it somewhere
	// else. The folder is not a field on screen: it arrives with the row that
	// was clicked and is never re-derived while the panel is open.
	//
	// It is only ever read and written on the UI goroutine (I-7). The debounce
	// is handed a copy, so the worker that writes it shares nothing with the
	// fields someone is still typing into.
	editing sourced

	timer *time.Timer
}

func (s *Shell) newFormulaEditor() *formulaEditor {
	e := &formulaEditor{
		kind:    widget.NewRadioGroup([]string{"Column", "Notation"}, nil),
		name:    widget.NewEntry(),
		expr:    widget.NewEntry(),
		applies: widget.NewLabel(""),
		preview: widget.NewLabel(""),
		foot:    widget.NewLabel(""),
	}
	e.kind.Horizontal = true
	e.expr.TextStyle = fyne.TextStyle{Monospace: true}
	e.applies.TextStyle = fyne.TextStyle{Monospace: true}
	e.preview.TextStyle = fyne.TextStyle{Monospace: true}
	e.foot.TextStyle = fyne.TextStyle{Monospace: true}

	e.kind.OnChanged = func(string) { s.formulaChanged() }
	e.name.OnChanged = func(string) { s.formulaChanged() }
	e.expr.OnChanged = func(string) { s.formulaChanged() }

	back := widget.NewButtonWithIcon("", theme.NavigateBackIcon(), func() { s.leaveEditor() })
	head := container.NewBorder(nil, nil, back,
		widget.NewButtonWithIcon("", theme.ConfirmIcon(), func() {
			s.applyEditing()
		}),
		widget.NewLabel("Formula"))

	form := container.NewVBox(
		e.kind,
		labelled("Name", e.name),
		labelled("Expression", e.expr),
		labelled("Applies to", e.applies),
		labelled("Preview · row 1", e.preview),
	)

	e.box = container.NewBorder(head, e.foot, nil, nil, container.NewVScroll(form))
	return e
}

// labelled is the small heading over each field. The headings are what tell
// someone which of the two kinds of formula they are writing, since the fields
// themselves look identical.
func labelled(title string, field fyne.CanvasObject) fyne.CanvasObject {
	l := widget.NewLabel(title)
	l.TextStyle = fyne.TextStyle{Bold: true}
	return container.NewVBox(l, field)
}

// newFormula opens the editor on a formula that does not exist yet. Its ID comes
// from the clock rather than from the name, because the name is about to be
// typed and an ID that followed it would rename the file on every keystroke.
func (s *Shell) newFormula() {
	// A formula that does not exist yet is not beside anything, so it goes to
	// the library: it is yours, written here, and nobody sent it to you.
	s.editFormula(sourced{
		Formula: library.Formula{
			Format: 1,
			ID:     fmt.Sprintf("formula-%d", time.Now().UnixNano()),
			Name:   "New formula",
			Kind:   library.KindColumn,
		},
		dir: s.libraryDir(),
	})
}

// placeName says which of the two folders a formula's file is sitting in, in
// the words the footer says it in.
//
// The editor writes back to whichever folder the row was opened out of, and one
// of those two folders is not necessarily yours. A .unof beside the document may
// have arrived in an email or be tracked in somebody's git repository, and a
// keystroke here rewrites it 600 ms later. Nothing asks first, on purpose: a
// formula is 400 bytes and this panel exists to edit it, so a dialog in front of
// every edit would make the shared case worse than the private one. What is owed
// instead is that the answer is on screen before the first keystroke rather than
// discovered after it.
func (s *Shell) placeName(dir string) string {
	if dir == s.libraryDir() {
		return "your library"
	}
	return "beside file"
}

// editFormula pushes the panel a level deeper, onto one formula's own file.
func (s *Shell) editFormula(f sourced) {
	d := s.drawer
	if d == nil {
		return
	}
	e := d.editor
	e.editing = f

	kind := "Column"
	if f.Kind == library.KindNotation {
		kind = "Notation"
	}
	e.kind.SetSelected(kind)
	e.name.SetText(f.Name)
	e.expr.SetText(f.Expr)
	e.foot.SetText("· " + f.ID + ".unof · " + s.placeName(f.dir))

	s.refreshPreview()
	e.box.Show()
	d.pages.Objects[0].Hide()
}

// leaveEditor goes back to the list, flushing anything the debounce still owes.
// The process may be about to end, and a formula that was typed and not written
// is one the person believes they have.
func (s *Shell) leaveEditor() {
	d := s.drawer
	if d == nil {
		return
	}
	s.flushFormula()
	d.editor.box.Hide()
	d.pages.Objects[0].Show()
	s.refreshDrawer()
}

// formulaChanged runs on every keystroke: the preview immediately, because that
// is what it is for, and the write on a debounce, because it is not.
//
// Everything that reads a widget happens here, on the UI goroutine. What the
// debounce is handed is a finished value and a path, so the goroutine that does
// the writing touches nothing anyone else is holding — the same handover the
// system design describes for every other job that runs off the UI thread (I-7).
func (s *Shell) formulaChanged() {
	s.refreshPreview()

	e := s.drawer.editor
	e.editing.Formula = s.editorFormula()
	pending, dir := e.editing.Formula, e.editing.dir
	// The wording is worked out here, with the rest of what the worker is
	// handed, because deciding it needs the library's path and that comes from
	// the app. The debounce below runs off the UI goroutine and must not go
	// back to the Shell for anything (I-7).
	place := s.placeName(dir)

	if e.timer != nil {
		e.timer.Stop()
	}
	e.timer = time.AfterFunc(autosaveDelay, func() {
		err := library.Save(dir, pending)
		at := time.Now()
		fyne.Do(func() {
			if err != nil {
				e.foot.SetText("not saved · " + err.Error())
				return
			}
			e.foot.SetText(fmt.Sprintf("autosaved %s · %s.unof · %s",
				at.Format("15:04:05"), pending.ID, place))
		})
	})
}

// flushFormula writes now rather than when the debounce would have.
//
// It is called wherever the editor stops being looked at: going back to the
// list, closing the drawer, and closing the window. A debounce that outlived any
// of those would either lose what was typed, or land on widgets after the thing
// that owns them has gone.
func (s *Shell) flushFormula() {
	if s.drawer == nil {
		return
	}
	e := s.drawer.editor
	if e.timer == nil {
		return
	}
	if !e.timer.Stop() {
		return // it has already fired, and its own write is in flight
	}
	e.timer = nil
	if err := library.Save(e.editing.dir, e.editing.Formula); err != nil {
		fyne.LogError("writing the formula", err)
	}
}

// editorFormula reads the fields into a value. It runs on the UI goroutine, and
// what it returns shares nothing with the widgets it came from, which is what
// makes it safe to hand to the debounce.
//
// refs is derived here rather than typed, so what the .unof says a formula reads
// cannot drift from what it actually reads. An expression that does not parse
// yet has no refs rather than the last ones that did: someone halfway through
// typing has not said anything about dependencies.
//
// It returns the formula alone and not the folder it will be written to: that
// arrived with the row someone clicked, and no field on this page can change
// it.
func (s *Shell) editorFormula() library.Formula {
	e := s.drawer.editor
	f := e.editing.Formula
	f.Name = strings.TrimSpace(e.name.Text)
	f.Expr = e.expr.Text
	f.Kind = library.KindColumn
	if e.kind.Selected == "Notation" {
		f.Kind = library.KindNotation
	}

	f.Refs = nil
	if f.Kind == library.KindColumn {
		if parsed, err := formula.Parse(f.Expr); err == nil {
			f.Refs = parsed.Refs()
		}
	}
	return f
}

// refreshPreview answers "what would this do" against the first row, and says
// why when the answer is that it would not work. Naming the failure here is the
// difference between finding out now and finding out from a column of #ERR.
func (s *Shell) refreshPreview() {
	e := s.drawer.editor
	w := s.active()

	e.applies.SetText(targetFor(w))

	if e.kind.Selected == "Notation" {
		if err := notation.Supported(e.expr.Text); err != nil {
			e.preview.SetText(err.Error())
			return
		}
		e.preview.SetText(notation.Render(e.expr.Text))
		return
	}

	parsed, err := formula.Parse(e.expr.Text)
	if err != nil {
		e.preview.SetText(err.Error())
		return
	}
	if w == nil || w.sheet == nil || w.sheet.Rows() == 0 {
		e.preview.SetText("no rows to preview against")
		return
	}
	got, err := w.sheet.Evaluate(parsed, 0)
	if err != nil {
		e.preview.SetText(err.Error())
		return
	}
	e.preview.SetText(got)
}

// applyEditing saves what is being edited and then uses it, which is the whole
// round trip a person came here for: write a formula, see what it does.
func (s *Shell) applyEditing() {
	e := s.drawer.editor
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	e.editing.Formula = s.editorFormula()
	if err := library.Save(e.editing.dir, e.editing.Formula); err != nil {
		fyne.LogError("writing the formula", err)
	}
	s.applyFormula(e.editing)
	s.leaveEditor()
}
