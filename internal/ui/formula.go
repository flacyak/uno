package ui

import (
	"fmt"
	"os"
	"path/filepath"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/formula"
	"github.com/flacyak/uno/internal/library"
)

// drawerWidth is what resource/formula.html draws it at. It is wide enough for a
// formula's name beside its kind and narrow enough to leave most of the grid
// readable underneath, which is the whole point of overlapping rather than
// resizing.
const drawerWidth = 296

// formulaDrawer is the library, over the grid.
//
// It overlaps the content rather than compressing it, and that is the decision
// the panel exists to make. Resizing the grid would reflow every visible column
// and move the cell that prompted someone to open the drawer in the first place,
// so an overlay leaves the data exactly where it was.
//
// There is one drawer and not one per workspace, the same way there is one
// proposal bar. The library is a fact about this machine rather than about a
// file; only the column it would act on belongs to the selected tab, and that is
// read from the workspace each time it is shown (I-3).
type formulaDrawer struct {
	box  *fyne.Container
	lay  *slideLayout
	bg   *canvas.Rectangle
	edge *canvas.Rectangle

	target *widget.Label
	list   *fyne.Container
	foot   *widget.Label
	pages  *fyne.Container

	editor *formulaEditor

	showing bool
	anim    *fyne.Animation
}

func (s *Shell) newFormulaDrawer() *formulaDrawer {
	d := &formulaDrawer{
		lay:    &slideLayout{edge: fromRight, off: 1},
		target: widget.NewLabel(""),
		list:   container.NewVBox(),
		foot:   widget.NewLabel(""),
	}
	d.target.TextStyle = fyne.TextStyle{Monospace: true}
	d.foot.TextStyle = fyne.TextStyle{Monospace: true}

	// The drawer floats over the grid, so it needs a ground of its own: rows
	// read through a transparent panel. The menu surface and not the overlay
	// one, for the reason the bar uses it — the overlay colour is the grid's own
	// white in the light theme, and a panel that matches what it sits on reads
	// as part of it.
	d.bg = canvas.NewRectangle(theme.Color(theme.ColorNameMenuBackground))
	d.edge = canvas.NewRectangle(theme.Color(theme.ColorNameSeparator))
	d.edge.SetMinSize(fyne.NewSize(1, 0))

	head := container.NewBorder(nil, nil,
		widget.NewLabel("Formulas"),
		widget.NewButtonWithIcon("", theme.CancelIcon(), func() { s.slideDrawer(false) }),
		d.target)

	add := widget.NewButtonWithIcon("New formula", theme.ContentAddIcon(), func() {
		s.newFormula()
	})

	body := container.NewBorder(head, container.NewVBox(add, d.foot), nil, nil,
		container.NewVScroll(d.list))

	d.editor = s.newFormulaEditor()

	// One page is shown at a time: the list, or one formula pushed a level
	// deeper. A Stack rather than two containers swapped in and out, so the
	// drawer's width is the wider of the two and never changes as you go in.
	d.pages = container.NewStack(body, d.editor.box)
	d.editor.box.Hide()

	// A fixed width, because a drawer that resized itself around whichever
	// formula name is longest would move the grid underneath it every time the
	// library changed.
	sized := canvas.NewRectangle(nil)
	sized.SetMinSize(fyne.NewSize(drawerWidth, 0))

	d.box = container.NewStack(d.bg,
		container.NewBorder(nil, nil, d.edge, nil, container.NewPadded(d.pages)),
		sized)
	d.box.Hide()
	return d
}

// paint re-reads the theme every time the drawer is shown, for the reason the
// bar does: window content is built before the app has settled its variant, so
// colours taken at construction come out of the wrong palette.
func (d *formulaDrawer) paint() {
	repaint(d.bg, theme.Color(theme.ColorNameMenuBackground))
	repaint(d.edge, theme.Color(theme.ColorNameSeparator))
}

// showDrawer fills the drawer from the library and the selected tab, then slides
// it in. It is called by the menu item rather than by refreshStatus, because
// opening the library is something a person asks for and not something that
// follows from where they clicked.
func (s *Shell) showDrawer() {
	if s.drawer == nil {
		return
	}
	s.refreshDrawer()
	s.drawer.paint()
	s.slideDrawer(true)
}

// refreshDrawer rebuilds the list and repoints the header at the active tab.
func (s *Shell) refreshDrawer() {
	d := s.drawer
	if d == nil {
		return
	}
	d.target.SetText(targetFor(s.active()))

	dir := s.libraryDir()
	found, err := library.Load(dir)
	if err != nil {
		// A library with one unreadable file is still a library. The rest are
		// listed and the failure is said once, in the footer, rather than in a
		// dialog that has to be dismissed before the others can be used.
		fyne.LogError("reading the formula library", err)
	}

	d.list.RemoveAll()
	for _, f := range found {
		d.list.Add(s.formulaRow(f))
	}
	d.list.Refresh()

	d.foot.SetText(fmt.Sprintf("%s · %s", plural(len(found), "formula"), shortDir(dir)))
}

// formulaRow is one entry: what it is called, what kind it is, and the two
// things you can do with it. Applying is the row itself, because that is what
// someone came to the drawer to do; editing is a button, because it is the
// rarer of the two and should not be what a mis-aimed click does.
func (s *Shell) formulaRow(f library.Formula) fyne.CanvasObject {
	kind := widget.NewLabel(badgeForKind(f.Kind))
	kind.TextStyle = fyne.TextStyle{Monospace: true}

	apply := widget.NewButton(f.Name, func() { s.applyFormula(f) })
	apply.Alignment = widget.ButtonAlignLeading
	apply.Importance = widget.LowImportance

	edit := widget.NewButtonWithIcon("", theme.DocumentCreateIcon(), func() {
		s.editFormula(f)
	})
	edit.Importance = widget.LowImportance

	return container.NewBorder(nil, nil, nil, container.NewHBox(kind, edit), apply)
}

// applyFormula binds a column formula to the column the selected cell is in, or
// writes notation into that cell. The drawer stays open: applying one formula is
// not evidence that you are finished with the library.
func (s *Shell) applyFormula(f library.Formula) {
	w := s.active()
	if w == nil || w.sheet == nil {
		return
	}

	if f.Kind == library.KindNotation {
		if err := w.sheet.Note(w.active.Row, w.active.Col, f.Expr); err != nil {
			dialog.ShowError(err, s.win)
			return
		}
		s.afterFormula(w)
		return
	}

	parsed, err := formula.Parse(f.Expr)
	if err != nil {
		dialog.ShowError(err, s.win)
		return
	}
	if err := w.sheet.Bind(w.active.Col, parsed); err != nil {
		// A refused binding is the useful half of the feature: a cycle named
		// here is two edits from being fixed, and one discovered during a
		// recalculation is not.
		dialog.ShowError(err, s.win)
		return
	}
	if w.formulaRefs == nil {
		w.formulaRefs = map[int]string{}
	}
	w.formulaRefs[w.active.Col] = f.ID
	s.afterFormula(w)
}

// afterFormula redraws what a binding changed. The whole table and not one cell,
// because a column that has just been filled is 4,812 cells and its header badge.
func (s *Shell) afterFormula(w *workspace) {
	s.touchRecent(w)
	if w.table != nil {
		w.table.Refresh()
	}
	s.refreshStatus()
}

// touchRecent records that this workspace changed, so the status bar and the
// tab's dirty mark agree with the sheet.
func (s *Shell) touchRecent(w *workspace) {
	if w.sheet != nil {
		w.showActive()
	}
}

// targetFor names the column the drawer would act on: the one the selected cell
// is in. Naming it in the header is what keeps applying a formula from requiring
// a click back into the sheet while the panel is open.
func targetFor(w *workspace) string {
	if w == nil || w.sheet == nil || w.sheet.Cols() == 0 {
		return ""
	}
	col := clampIndex(w.active.Col, w.sheet.Cols())
	return fmt.Sprintf("column %s · %s", colName(col), w.sheet.Columns[col].Header)
}

func badgeForKind(k library.Kind) string {
	if k == library.KindNotation {
		return "math"
	}
	return "col"
}

// libraryDir is where one person's formulas live on one machine: the per-user,
// per-app directory Fyne already resolves for each desktop, so there is no
// platform branching here to get wrong.
func (s *Shell) libraryDir() string {
	a := fyne.CurrentApp()
	if a == nil {
		return ""
	}
	root := a.Storage().RootURI()
	if root == nil {
		return ""
	}
	return filepath.Join(root.Path(), "formulas")
}

// shortDir writes the library's path the way a person would say it, so the
// footer reads ~/.local/share/uno/formulas rather than repeating their name back
// at them.
func shortDir(dir string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" || !filepath.IsAbs(dir) {
		return dir
	}
	rel, err := filepath.Rel(home, dir)
	if err != nil || rel == ".." || filepath.IsAbs(rel) {
		return dir
	}
	return filepath.Join("~", rel)
}

// slideDrawer animates the panel in or out. It is the bar's slide with the other
// layout: the same idempotence guard, the same stop-the-previous-animation, and
// the same Hide only once the travel has finished, so the way it leaves is as
// visible as the way it arrived.
func (s *Shell) slideDrawer(in bool) {
	d := s.drawer
	if d == nil || d.showing == in {
		return
	}
	if !in {
		// Whatever the debounce still owes is written before the panel that
		// owns the fields goes away.
		s.flushFormula()
	}
	d.showing = in

	if d.anim != nil {
		d.anim.Stop()
	}
	d.box.Show()

	from, to := d.lay.off, float32(1)
	if in {
		to = 0
	}
	d.anim = fyne.NewAnimation(slideSpan, func(f float32) {
		d.lay.off = from + (to-from)*f
		d.lay.place()
		if f == 1 && !in {
			d.box.Hide()
		}
	})
	d.anim.Curve = fyne.AnimationEaseInOut
	d.anim.Start()
}

// toggleDrawer is what the menu item and its shortcut do.
func (s *Shell) toggleDrawer() {
	if s.drawer == nil {
		return
	}
	if s.drawer.showing {
		s.slideDrawer(false)
		return
	}
	s.showDrawer()
}

// retargetDrawer repoints the open drawer at the newly selected tab. Only the
// header moves: the library it lists is the same library whichever file is in
// front of it.
func (s *Shell) retargetDrawer() {
	if s.drawer == nil || !s.drawer.showing {
		return
	}
	s.drawer.target.SetText(targetFor(s.active()))
	s.drawer.editor.applies.SetText(targetFor(s.active()))
}
