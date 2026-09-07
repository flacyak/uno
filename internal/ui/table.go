package ui

import (
	"strconv"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/flacyak/uno/internal/document"
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

// grid is the sheet's table: a widget.Table in every respect but Enter. The
// table itself does nothing with that key, and someone working the grid from the
// keyboard needs the same way into a cell that a second click is.
type grid struct {
	widget.Table

	s *Shell
	w *workspace
}

func (g *grid) TypedKey(k *fyne.KeyEvent) {
	if k.Name == fyne.KeyReturn || k.Name == fyne.KeyEnter {
		g.s.beginEdit(g.w) // which guards an empty sheet and an editor already open
		return
	}
	g.Table.TypedKey(k)
}

// newTable binds a grid to a workspace. widget.Table only builds the cells it
// can see and recycles them as you scroll, so a 4,812-row file costs the same to
// display as a 20-row one. The price is that update runs constantly, so it must
// stay cheap and must not allocate.
//
// It reads through the workspace rather than closing over one sheet because undo
// rebuilds the sheet from the raw bytes and puts a new one in its place. Binding
// to the workspace is what lets that swap be a Refresh rather than a new grid.
func (s *Shell) newTable(w *workspace) *grid {
	tbl := &grid{s: s, w: w}
	tbl.Length = func() (int, int) { return w.sheet.Rows(), w.sheet.Cols() }
	tbl.CreateCell = func() fyne.CanvasObject { return s.newCell(w) }
	tbl.UpdateCell = func(id widget.TableCellID, o fyne.CanvasObject) {
		o.(*cell).show(id)
	}
	tbl.ExtendBaseWidget(tbl)

	// The table moves a highlight with the arrow keys and only promotes it to a
	// selection on Space. uno has one idea of where you are — active, the editor
	// bar and the cell reference all follow the selection — so the highlight is
	// not allowed to be somewhere else. Select sets the highlight itself and does
	// not call back here, so this settles rather than loops.
	tbl.OnHighlighted = func(id widget.TableCellID) { tbl.Select(id) }

	// Header row carries the column names and type badges; header column is the
	// row-number gutter. Neither is part of the data, so neither shifts indices.
	tbl.ShowHeaderRow = true
	tbl.ShowHeaderColumn = true

	tbl.CreateHeader = func() fyne.CanvasObject { return newHeader() }
	tbl.UpdateHeader = func(id widget.TableCellID, o fyne.CanvasObject) {
		name, badge := headerParts(o)
		switch {
		case id.Row < 0: // column header
			c := w.sheet.Columns[id.Col]
			name.SetText(c.Header)
			badge.SetText(badgeFor(c))
		case id.Col < 0: // row-number gutter, 1-based for humans
			name.SetText(strconv.Itoa(id.Row + 1))
			badge.SetText("")
		}
	}

	// Widths are measured once, from the sheet as it was opened. A later edit
	// does not resize its column: a grid that rearranges itself while you are
	// reading it is harder to work in than one that occasionally clips.
	for i, c := range w.sheet.Columns {
		tbl.SetColumnWidth(i, widthFor(w.sheet, i, c))
	}
	return tbl
}

// cell is one square of the grid. It is a label almost always, and the
// workspace's inline editor for as long as it is the cell being edited: one
// entry moved between squares rather than an entry in every square, for the same
// reason there is one editor bar. The grid recycles these constantly, so what
// they cost is what a big file costs to scroll (I-1).
type cell struct {
	widget.BaseWidget

	s     *Shell
	w     *workspace
	id    widget.TableCellID
	label *widget.Label
	box   *fyne.Container
}

func (s *Shell) newCell(w *workspace) *cell {
	c := &cell{s: s, w: w, label: widget.NewLabel("")}
	c.box = container.NewStack(c.label)
	c.ExtendBaseWidget(c)
	return c
}

func (c *cell) CreateRenderer() fyne.WidgetRenderer { return widget.NewSimpleRenderer(c.box) }

// show points this recycled square at another cell of the sheet. It is the
// table's update closure, so it runs constantly and swaps the editor in or out
// only when that changes something.
func (c *cell) show(id widget.TableCellID) {
	c.id = id
	c.label.SetText(c.w.sheet.Display(id.Row, id.Col))

	if c.w.editing && c.w.active == (document.Cell{Row: id.Row, Col: id.Col}) {
		c.takeInline()
		return
	}
	c.dropInline()
}

// takeInline moves the workspace's one editor into this square, off whichever
// square was holding it. Taking it off is the part that matters: a square that
// has scrolled out of view is never updated again, so nothing else would ever
// tell it to let go, and the same entry would sit in two places at once.
func (c *cell) takeInline() {
	if c.w.inlineIn == c {
		return
	}
	if prev := c.w.inlineIn; prev != nil {
		prev.showLabel()
	}
	c.w.inlineIn = c
	c.box.Objects[0] = c.w.inline
	c.box.Refresh()
}

func (c *cell) dropInline() {
	if c.w.inlineIn != c {
		return
	}
	c.w.inlineIn = nil
	c.showLabel()
}

func (c *cell) showLabel() {
	c.box.Objects[0] = c.label
	c.box.Refresh()
}

// Tapped chooses this cell, or opens it for typing when it is the cell already
// chosen. The table's own Tapped never runs for a square that handles its own
// tap — hit-testing keeps the deepest object it finds — so everything that tap
// used to do happens in tapCell instead.
func (c *cell) Tapped(*fyne.PointEvent) { c.s.tapCell(c.w, c.id) }

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
		if m := measure(sh.Display(row, col), size, fyne.TextStyle{}); m > w {
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
