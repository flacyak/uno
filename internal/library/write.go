package library

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/flacyak/uno/internal/safefile"
)

// Save writes f to <dir>/<id>.unof.
//
// It goes through safefile because this is the write that runs on a debounce
// while someone is still typing, which is exactly when a crash is most likely.
// An interrupted autosave loses the keystroke rather than the formula that was
// already there.
//
// The timestamps are set here rather than taken from the caller: modified is
// what this save is, and created is filled in only the first time, so a formula
// cannot come to claim it was written after it was last edited.
func Save(dir string, f Formula) error {
	name, err := fileName(f.ID)
	if err != nil {
		return err
	}

	f.Format = formatVersion
	f.Modified = time.Now().UTC().Truncate(time.Second)
	if f.Created.IsZero() {
		f.Created = f.Modified
	}

	// The first formula a person writes arrives before the directory does.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	return safefile.Write(filepath.Join(dir, name), func(w io.Writer) error {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")  // someone will read this file in a diff
		enc.SetEscapeHTML(false) // see Formula.MarshalJSON: a "<" stays a "<"
		return enc.Encode(f)
	})
}
