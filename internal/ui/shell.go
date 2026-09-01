// Package ui owns the window, the tabs, the menu and the grid. It never opens a
// file itself: it receives a reader and hands it to ingest (I-6).
package ui

import (
	"fmt"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/widget"
)

// Shell is the window's contents: a strip of workspace tabs over a status bar.
// It holds no data of its own; everything about an open file lives in the
// workspace that owns it.
type Shell struct {
	win    fyne.Window
	tabs   *container.DocTabs
	status *widget.Label
	byTab  map[*container.TabItem]*workspace
}

// NewShell wires the window's menu, shortcut and drop handler. The content is
// built separately by Content, so a test can drive a shell without a canvas.
func NewShell(w fyne.Window) *Shell {
	s := &Shell{win: w, byTab: map[*container.TabItem]*workspace{}}

	// One shortcut definition covers every desktop: KeyModifierShortcutDefault
	// is Cmd on macOS and Ctrl on Linux and Windows.
	open := fyne.NewMenuItem("Open…", s.chooseFile)
	open.Shortcut = &desktop.CustomShortcut{
		KeyName:  fyne.KeyO,
		Modifier: fyne.KeyModifierShortcutDefault,
	}

	w.SetMainMenu(fyne.NewMainMenu(fyne.NewMenu("File", open)))
	if c := w.Canvas(); c != nil {
		c.AddShortcut(open.Shortcut, func(fyne.Shortcut) { s.chooseFile() })
	}

	// Dropping files is the same request as choosing one, so it lands in load too.
	w.SetOnDropped(s.onDropped)

	return s
}

// Content builds the tab strip and the status bar. uno always has at least one
// workspace, so even an empty app shows a tab.
func (s *Shell) Content() fyne.CanvasObject {
	s.status = widget.NewLabel("")
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

	return container.NewBorder(nil, s.status, nil, nil, s.tabs)
}

// active returns the workspace behind the selected tab, or nil when there is none.
func (s *Shell) active() *workspace {
	if s.tabs == nil {
		return nil
	}
	return s.byTab[s.tabs.Selected()]
}

// refreshStatus repoints the status bar at the active workspace and nothing
// else, so switching tabs is what changes what it describes.
func (s *Shell) refreshStatus() {
	if s.status == nil {
		return
	}
	s.status.SetText(statusFor(s.active()))
}

func statusFor(w *workspace) string {
	if w == nil || w.sheet == nil {
		return "no file open"
	}
	return strings.Join([]string{
		plural(w.sheet.Rows(), "row"),
		plural(w.sheet.Cols(), "col"),
		w.sheet.Source, // how ingest read it; ui does not interpret it
		"read-only",
	}, " · ")
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
