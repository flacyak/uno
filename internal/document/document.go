// Package document reads and writes the .uno container: a zip holding the bytes
// you were originally given, deflated, alongside the log of what you did to
// them. It is the only package that imports archive/zip (I-5), and it consults
// nothing outside the file it was handed — no original, no stored path, no
// network.
package document

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/flacyak/uno/internal/sheet"
)

// formatVersion is the layout this build writes and the highest it reads. It is
// the public API of uno: everything under internal/ can be reshaped on any
// afternoon, but a .uno travels to other machines and stays readable there.
const formatVersion = 1

const generator = "uno 0.2.0"

// The fixed entries. The source entry is not fixed, because calling a TSV's
// bytes source.csv would be a small lie told to everyone who unzips the file.
const (
	manifestEntry = "uno.json"
	stateEntry    = "sheet/state.json"
	logEntry      = "edits/log.jsonl"
	sourceDir     = "data/source"
)

// Document is one .uno in memory, and one workspace.
//
// The split matters at save time. Write consumes Manifest, Raw, State, Edits and
// Extra, all of which are values the UI goroutine can snapshot and hand over, so
// the deflate and the fsync run on a worker while the person keeps typing.
// Sheet is live and mutable, and only Read ever sets it.
type Document struct {
	// Manifest is mostly derived: Write fills in the format, the generator, the
	// timestamps, the sizes, the hash, the counts and the entry names from what
	// it actually writes, so the file cannot come to describe a different file.
	// The caller owns the three facts the writer cannot see — Created,
	// Source.Name, and the Sheet dimensions the log builds.
	Manifest Manifest
	Raw      []byte
	State    State
	Edits    []sheet.Edit

	// Extra carries entries this build did not recognise through to the next
	// save. An older uno opening a file written by a newer one must not quietly
	// drop what it could not read and then write that loss back over the file.
	Extra map[string][]byte

	// Sheet is the replayed result, set by Read and ignored by Write.
	Sheet *sheet.Sheet
}

// Manifest is uno.json: what this file is, where its bytes came from, and where
// the other entries live.
type Manifest struct {
	Format    int       `json:"format"`
	Generator string    `json:"generator"`
	Created   time.Time `json:"created"`
	Modified  time.Time `json:"modified"`
	Source    Source    `json:"source"`
	Sheet     SheetRef  `json:"sheet"`
	Edits     EditsRef  `json:"edits"`
}

// Source is the provenance of the raw bytes.
//
// Name and not path: a path is precisely the thing that stops being true when
// the file travels. The name is kept because it is useful to display and because
// ingest picks its decoder from the extension; nothing here is ever resolved
// against the filesystem.
//
// The delimiter and encoding are deliberately absent. The reader derives them
// from these same bytes with the same code that derived them the first time, so
// a stored copy could only ever be a second opinion that disagrees.
type Source struct {
	Name   string `json:"name"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
	Entry  string `json:"entry"`
}

// SheetRef is the shape of the grid the raw bytes and the log add up to. It is
// written so that a recents list or a file inspector can say how big a workspace
// is without decoding it.
type SheetRef struct {
	Rows  int    `json:"rows"`
	Cols  int    `json:"cols"`
	Entry string `json:"entry"`
}

type EditsRef struct {
	Count int    `json:"count"`
	Entry string `json:"entry"`
}

// State is what the grid looked like, not what it held. Everything the data
// itself contains is reachable from the raw bytes and the log, so nothing that
// can be replayed is written here.
type State struct {
	Active Cell `json:"active"`
}

// Cell is a position in the grid. It is where the person was, which is a fact
// about the session rather than about the data.
type Cell struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

// sourceEntry names the raw entry after the file it holds, so unzip -l on a
// workspace opened from a TSV says data/source.tsv.
func sourceEntry(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = ".csv"
	}
	return sourceDir + ext
}
