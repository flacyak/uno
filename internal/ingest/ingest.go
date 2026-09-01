// Package ingest turns bytes into a *sheet.Sheet. It is the only package that
// knows a file had a delimiter, an encoding or a header row (I-5), so adding a
// format later never reaches the grid.
package ingest

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/flacyak/uno/internal/sheet"
)

// Read picks a decoder from the extension, then from the bytes. It is the only
// exported entry point, which keeps format knowledge inside this package.
func Read(name string, r io.Reader) (*sheet.Sheet, error) {
	buf := bufio.NewReader(r)

	switch strings.ToLower(filepath.Ext(name)) {
	case ".json":
		return nil, fmt.Errorf("%s: JSON is not supported yet", name)
	case ".tsv":
		return readSeparated(name, buf, '\t')
	default:
		return readSeparated(name, buf, sniffDelimiter(buf))
	}
}

func readSeparated(name string, r io.Reader, comma rune) (*sheet.Sheet, error) {
	cr := csv.NewReader(r)
	cr.Comma = comma
	cr.FieldsPerRecord = -1 // exports are ragged; pad rows, do not reject the file
	cr.LazyQuotes = true

	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("%s: file is empty", name)
	}

	sh := sheet.New(name, rows[0], rows[1:])
	sh.Source = describe(comma)
	return sh, nil
}

// describe is how the status bar says what was guessed, so a wrong guess is
// visible rather than silent.
func describe(comma rune) string {
	if comma == '\t' {
		return "UTF-8 · tab-separated"
	}
	return fmt.Sprintf("UTF-8 · delimiter %q", comma)
}
