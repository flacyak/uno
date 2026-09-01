package ui

import (
	"fmt"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/sheet"
)

// A workspace is one open file: one tab, one sheet, one grid (I-3). It is also
// the blast radius. M2's edit log will hang off this struct, so a pattern
// learned in one file can never be offered against another.
type workspace struct {
	sheet *sheet.Sheet
	table *widget.Table
	tab   *container.TabItem
}

// newWorkspace builds an empty workspace showing the drop target. It gets its
// real name when a file lands in it.
func (s *Shell) newWorkspace() *workspace {
	w := &workspace{}
	w.tab = container.NewTabItem(untitled(len(s.tabs.Items)+1), s.emptyState())
	s.byTab[w.tab] = w
	return w
}

func untitled(n int) string { return fmt.Sprintf("Untitled %d", n) }

// setSheet swaps a loaded sheet into this workspace and replaces the drop
// target with the grid. Nothing outside the workspace sees the sheet until
// this returns, so a failed load leaves the previous content untouched.
func (s *Shell) setSheet(w *workspace, sh *sheet.Sheet) {
	w.sheet = sh
	w.table = newTable(sh)
	w.tab.Content = w.table
	w.tab.Text = sh.Name
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
	exts := widget.NewLabelWithStyle(".csv  .tsv  .json", fyne.TextAlignCenter,
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
