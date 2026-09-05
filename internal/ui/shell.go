// Package ui owns the window, the tabs, the menu and the grid. It never opens a
// file itself: it receives a reader and hands it to ingest, or a path and hands
// it to document (I-6).
package ui

import (
	"fmt"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/widget"
)

// WindowWidth and WindowHeight are the size uno asks its window to be. They live
// beside the shell that fills it rather than in main.go because the filming rig
// in internal/uitest has to ask a tiling compositor for the same rectangle, and
// a preview cropped to a number that has since moved is worse than no preview.
const (
	WindowWidth  = 1100
	WindowHeight = 720
)

// Shell is the window's contents: a strip of workspace tabs over a status bar.
// It holds no data of its own; everything about an open file lives in the
// workspace that owns it.
type Shell struct {
	win    fyne.Window
	tabs   *container.DocTabs
	status *widget.Label
	cell   *widget.Label
	bar    *proposalBar
	undoIt *fyne.MenuItem
	byTab  map[*container.TabItem]*workspace
}

// NewShell wires the window's menu, shortcuts and drop handler. The content is
// built separately by Content, so a test can drive a shell without a canvas.
func NewShell(w fyne.Window) *Shell {
	s := &Shell{win: w, byTab: map[*container.TabItem]*workspace{}}

	// One shortcut definition covers every desktop: KeyModifierShortcutDefault
	// is Cmd on macOS and Ctrl on Linux and Windows.
	open := menuItem("Open…", key(fyne.KeyO, 0), s.chooseFile)
	save := menuItem("Save", key(fyne.KeyS, 0), s.save)
	saveAs := menuItem("Save As…", key(fyne.KeyS, fyne.KeyModifierShift), s.saveAs)

	// Undo takes the framework's own undo shortcut rather than a custom Ctrl+Z,
	// and it has to. The driver turns Ctrl+Z into a fyne.ShortcutUndo, matches
	// the main menu by shortcut name before the focused widget is offered it,
	// and hands anything unmatched to whatever has focus — which, while a value
	// is being typed, is a text field with an undo of its own. Naming the
	// standard shortcut here is what puts Ctrl+Z on the sheet rather than on the
	// last few characters typed into the editor bar.
	s.undoIt = menuItem("Undo", &fyne.ShortcutUndo{}, s.undo)

	w.SetMainMenu(fyne.NewMainMenu(
		fyne.NewMenu("File", open, fyne.NewMenuItemSeparator(), save, saveAs),
		fyne.NewMenu("Edit", s.undoIt),
	))

	if c := w.Canvas(); c != nil {
		for _, it := range []*fyne.MenuItem{open, save, saveAs, s.undoIt} {
			c.AddShortcut(it.Shortcut, func(fyne.Shortcut) { it.Action() })
		}
	}

	// Dropping files is the same request as choosing one, so it lands in load too.
	w.SetOnDropped(s.onDropped)

	// Nothing in a shipped build: demo_off.go is what this reaches unless the
	// "demo" tag is set, and then it is the scripted preview docs/preview.gif is
	// filmed from.
	s.startDemo()

	return s
}

// menuItem pairs a label with the shortcut that reaches the same action, so the
// menu and the keyboard can never drift apart.
func menuItem(label string, sc fyne.Shortcut, action func()) *fyne.MenuItem {
	it := fyne.NewMenuItem(label, action)
	it.Shortcut = sc
	return it
}

func key(name fyne.KeyName, extra fyne.KeyModifier) fyne.Shortcut {
	return &desktop.CustomShortcut{
		KeyName:  name,
		Modifier: fyne.KeyModifierShortcutDefault | extra,
	}
}

// Content builds the tab strip and the status bar. uno always has at least one
// workspace, so even an empty app shows a tab.
func (s *Shell) Content() fyne.CanvasObject {
	s.status = widget.NewLabel("")
	s.cell = widget.NewLabel("")
	s.tabs = container.NewDocTabs()

	// Setting CreateTab is what draws the "+"; Fyne appends and selects for us,
	// so uno hand-rolls no tab chrome.
	s.tabs.CreateTab = func() *container.TabItem { return s.newWorkspace().tab }

	s.tabs.OnSelected = func(*container.TabItem) { s.refreshStatus() }
	s.tabs.OnClosed = func(t *container.TabItem) {
		delete(s.byTab, t)
		if len(s.tabs.Items) == 0 {
			// uno is never tabless: closing the last one leaves an empty workspace.
			s.tabs.Append(s.newWorkspace().tab)
		}
		s.refreshStatus()
	}

	s.tabs.Append(s.newWorkspace().tab)
	s.refreshStatus()

	// The cell reference sits at the trailing end of the same bar, which is
	// where a spreadsheet says which cell you are in.
	status := container.NewBorder(nil, nil, nil, s.cell, s.status)
	window := container.NewBorder(nil, status, nil, nil, s.tabs)

	// The recogniser's question rides above all of it, anchored to the bottom
	// edge it slides in from.
	s.bar = s.newProposalBar()
	return container.New(s.bar.lay, window, s.bar.box)
}

// active returns the workspace behind the selected tab, or nil when there is none.
func (s *Shell) active() *workspace {
	if s.tabs == nil {
		return nil
	}
	return s.byTab[s.tabs.Selected()]
}

// refreshStatus repoints the window at the active workspace and nothing else, so
// switching tabs is what changes what it describes. Tab labels are refreshed
// with it because a background save can clear a dot on a tab nobody is looking at.
func (s *Shell) refreshStatus() {
	w := s.active()
	if s.status != nil {
		s.status.SetText(statusFor(w))
		s.cell.SetText(cellRef(w))
	}
	s.refreshTabs()
	s.refreshUndo(w)
	s.showProposal() // the question follows the selected tab, like everything else here
	s.win.SetTitle(titleFor(w))
}

// refreshUndo greys the item out when there is nothing behind the active
// workspace to step back to. The keyboard reaches the action whatever the item
// says, which is why undo checks for itself rather than trusting this.
func (s *Shell) refreshUndo(w *workspace) {
	off := w == nil || w.sheet == nil || w.sheet.EditCount() == 0
	if s.undoIt == nil || s.undoIt.Disabled == off {
		return
	}
	s.undoIt.Disabled = off
	if m := s.win.MainMenu(); m != nil {
		m.Refresh()
	}
}

// undo steps the active workspace back one operation.
func (s *Shell) undo() {
	w := s.active()
	if w == nil || w.sheet == nil || w.sheet.EditCount() == 0 {
		return // nothing was done here, so there is nothing to take back
	}

	// An editor left open in the grid is pointed at a value that is about to be
	// rebuilt, and nothing in it was ever committed.
	s.endEdit(w, false)

	if err := w.undo(); err != nil {
		dialog.ShowError(err, s.win)
		return
	}

	// The sheet was rebuilt rather than patched, so the grid and the editor both
	// re-read it instead of being told which cell moved.
	w.table.Refresh()
	w.showActive()
	s.rescan(w) // the log is shorter, so what it supports may have changed
	s.refreshStatus()
}

// refreshTabs writes the dirty marker onto every tab. The dot is the only thing
// that says a workspace holds changes no file has yet.
func (s *Shell) refreshTabs() {
	changed := false
	for tab, w := range s.byTab {
		label := w.name
		if w.dirty() {
			label += " •"
		}
		if tab.Text != label {
			tab.Text = label
			changed = true
		}
	}
	if changed {
		s.tabs.Refresh()
	}
}

func statusFor(w *workspace) string {
	if w == nil || w.sheet == nil {
		return "no file open"
	}

	parts := []string{
		plural(w.sheet.Rows(), "row"),
		plural(w.sheet.Cols(), "col"),
		w.sheet.Source, // how ingest read it; ui does not interpret it
	}
	if n := w.sheet.EditCount(); n > 0 {
		parts = append(parts, plural(n, "edit"))
	}
	switch {
	case w.dirty():
		parts = append(parts, "unsaved")
	case w.path != "":
		// Saved, and still naming where the data came from: that provenance is
		// read from the manifest, not from anything on this machine.
		parts = append(parts, "saved", "from "+w.manifest.Source.Name)
	}
	return strings.Join(parts, " · ")
}

func titleFor(w *workspace) string {
	if w == nil || w.sheet == nil {
		return "uno"
	}
	if w.dirty() {
		return "uno — " + w.name + " • edited"
	}
	return "uno — " + w.name
}

// cellRef names the selected cell the way a spreadsheet does, so what the editor
// bar is pointed at can be read off the window rather than counted.
func cellRef(w *workspace) string {
	if w == nil || w.sheet == nil || w.sheet.Rows() == 0 {
		return ""
	}
	return colName(w.active.Col) + fmt.Sprint(w.active.Row+1)
}

// colName renders 0 as A and 26 as AA. Column letters run like an odometer with
// no zero digit, so the leading letter shifts down by one on each carry.
func colName(col int) string {
	var b []byte
	for col >= 0 {
		b = append([]byte{byte('A' + col%26)}, b...)
		col = col/26 - 1
	}
	return string(b)
}

func plural(n int, unit string) string {
	if n == 1 {
		return "1 " + unit
	}
	return group(n) + " " + unit + "s"
}

// group renders 4812 as "4,812". The status bar is read by a person checking a
// row count against wc -l, and four digits are easier to check with a comma.
func group(n int) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	head := len(s) % 3
	if head > 0 {
		b.WriteString(s[:head])
	}
	for i := head; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
