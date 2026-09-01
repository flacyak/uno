package ingest

import (
	"strings"
	"testing"
)

func TestReadSniffsDelimiterFromBytes(t *testing.T) {
	for _, c := range []struct {
		name, body, wantSource string
	}{
		{"comma", "a,b,c\n1,2,3\n", `UTF-8 · delimiter ','`},
		{"semicolon", "a;b;c\n1;2;3\n", `UTF-8 · delimiter ';'`},
		{"pipe", "a|b|c\n1|2|3\n", `UTF-8 · delimiter '|'`},
		{"tab in a .csv", "a\tb\tc\n1\t2\t3\n", "UTF-8 · tab-separated"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, err := Read("f.csv", strings.NewReader(c.body))
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if s.Cols() != 3 {
				t.Errorf("Cols() = %d, want 3", s.Cols())
			}
			if s.Source != c.wantSource {
				t.Errorf("Source = %q, want %q", s.Source, c.wantSource)
			}
		})
	}
}

// The extension decides before the bytes do, so a single-column TSV is not
// mistaken for a comma-delimited file with one field.
func TestReadTrustsTheTSVExtension(t *testing.T) {
	s, err := Read("f.tsv", strings.NewReader("a\tb\n1\t2\n"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if s.Cols() != 2 {
		t.Errorf("Cols() = %d, want 2", s.Cols())
	}
}

// A separator inside a quoted field is data, not structure.
func TestSniffIgnoresDelimitersInsideQuotes(t *testing.T) {
	s, err := Read("f.csv", strings.NewReader(
		"name,role\n\"Okafor, Ada\",lead\n\"Iyer, Ben\",eng\n"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if s.Cols() != 2 {
		t.Fatalf("Cols() = %d, want 2", s.Cols())
	}
	if got := s.At(0, 0); got != "Okafor, Ada" {
		t.Errorf("At(0,0) = %q, want %q", got, "Okafor, Ada")
	}
}

func TestReadPadsRaggedRowsRatherThanRejectingTheFile(t *testing.T) {
	s, err := Read("f.csv", strings.NewReader("a,b,c\n1,2,3\n4\n5,6,7\n"))
	if err != nil {
		t.Fatalf("a ragged export must open, got: %v", err)
	}
	if s.Rows() != 3 {
		t.Errorf("Rows() = %d, want 3", s.Rows())
	}
	if got := s.At(1, 2); got != "" {
		t.Errorf("At(1,2) = %q, want empty", got)
	}
}

func TestReadHandlesCRLF(t *testing.T) {
	s, err := Read("f.csv", strings.NewReader("a,b\r\n1,2\r\n"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got := s.At(0, 1); got != "2" {
		t.Errorf("At(0,1) = %q, want %q", got, "2")
	}
}

func TestReadNamesTheFileInEveryError(t *testing.T) {
	for _, c := range []struct{ name, file, body, want string }{
		{"empty file", "empty.csv", "", "file is empty"},
		{"json", "data.json", "[]", "not supported yet"},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := Read(c.file, strings.NewReader(c.body))
			if err == nil {
				t.Fatal("want an error, got nil")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("error = %q, want it to mention %q", err, c.want)
			}
			// An error dialog that does not name the file is useless in a
			// twelve-file drop.
			if !strings.Contains(err.Error(), c.file) {
				t.Errorf("error = %q, want it to name %q", err, c.file)
			}
		})
	}
}

// A header-only file is a valid sheet with no rows, not an error.
func TestReadAcceptsAHeaderWithNoRows(t *testing.T) {
	s, err := Read("f.csv", strings.NewReader("a,b,c\n"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if s.Rows() != 0 || s.Cols() != 3 {
		t.Errorf("Rows()=%d Cols()=%d, want 0 and 3", s.Rows(), s.Cols())
	}
}
