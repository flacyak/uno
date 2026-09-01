package ui

import (
	"strconv"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/sheet"
)

// Column sizing, from resource/workspace.html. Content decides the size and the
// viewport only decides how much you see, so a narrow window shows fewer columns
// rather than squeezing them.
const (
	minColWidth = 64  // a column of empty cells still has to show what it is called
	maxColWidth = 420 // one 4,000-character cell must not make a 4,000-character column
	widthSample = 200 // bounded work at open: not 4,812 measurements per column
	cellPadding = 24
)

// newTable binds a grid to a sheet. widget.Table only builds the cells it can
// see and recycles them as you scroll, so a 4,812-row file costs the same to
// display as a 20-row one. The price is that update runs constantly, so it must
// stay cheap and must not allocate.
func newTable(sh *sheet.Sheet) *widget.Table {
	tbl := widget.NewTable(
		func() (int, int) { return sh.Rows(), sh.Cols() },
		func() fyne.CanvasObject { return widget.NewLabel("") },
		func(id widget.TableCellID, o fyne.CanvasObject) {
			o.(*widget.Label).SetText(sh.At(id.Row, id.Col))
		},
	)

	// Header row carries the column names and type badges; header column is the
	// row-number gutter. Neither is part of the data, so neither shifts indices.
	tbl.ShowHeaderRow = true
	tbl.ShowHeaderColumn = true

	tbl.CreateHeader = func() fyne.CanvasObject { return newHeader() }
	tbl.UpdateHeader = func(id widget.TableCellID, o fyne.CanvasObject) {
		name, badge := headerParts(o)
		switch {
		case id.Row < 0: // column header
			c := sh.Columns[id.Col]
			name.SetText(c.Header)
			badge.SetText(badgeFor(c))
		case id.Col < 0: // row-number gutter, 1-based for humans
			name.SetText(strconv.Itoa(id.Row + 1))
			badge.SetText("")
		}
	}

	for i, c := range sh.Columns {
		tbl.SetColumnWidth(i, widthFor(sh, i, c))
	}
	return tbl
}

func newHeader() *fyne.Container {
	name := widget.NewLabel("")
	name.TextStyle = fyne.TextStyle{Bold: true}
	badge := widget.NewLabel("")
	badge.TextStyle = fyne.TextStyle{Monospace: true}
	return container.NewHBox(name, badge)
}

func headerParts(o fyne.CanvasObject) (name, badge *widget.Label) {
	c := o.(*fyne.Container)
	return c.Objects[0].(*widget.Label), c.Objects[1].(*widget.Label)
}

// badgeFor names the column's kind. A flagged column reads "text?" because the
// question mark is the point: the values look numeric and do not parse, which is
// exactly the condition M2's recorder offers to fix.
func badgeFor(c sheet.Column) string {
	if c.Flagged {
		return c.Kind.String() + "?"
	}
	return c.Kind.String()
}

// widthFor sizes a column from its header plus a sample of the top rows, then
// clamps. Past the ceiling a value clips with an ellipsis rather than widening:
// a column that grows when a wider value scrolls into view shifts every column
// right of it, and the cell being read jumps away mid-scroll.
func widthFor(sh *sheet.Sheet, col int, c sheet.Column) float32 {
	size := theme.TextSize()

	// The header carries the badge beside the name, so it must fit both.
	w := measure(c.Header, size, fyne.TextStyle{Bold: true}) +
		measure(badgeFor(c), size, fyne.TextStyle{Monospace: true})

	for row := 0; row < sh.Rows() && row < widthSample; row++ {
		if m := measure(sh.At(row, col), size, fyne.TextStyle{}); m > w {
			w = m
		}
	}

	return clamp(w+cellPadding, minColWidth, maxColWidth)
}

func measure(s string, size float32, style fyne.TextStyle) float32 {
	if s == "" {
		return 0
	}
	return fyne.MeasureText(s, size, style).Width
}

func clamp(v, lo, hi float32) float32 {
	return min(max(v, lo), hi)
}
