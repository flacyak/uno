package document

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/flacyak/uno/internal/sheet"
)

// Write saves a document to path. The file already at that path is never opened
// for writing: we build a sibling temp file and rename over it, so an
// interrupted save loses the new data rather than the data already saved.
//
// Saving is the one operation in uno that can destroy something, and every
// failure mode worth designing for resolves to the same promise — the previously
// saved file is still there.
func Write(path string, d *Document) (err error) {
	// Same directory, so the rename stays on one filesystem and stays atomic.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".uno-*.part")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name()) // a failed save leaves no debris
		}
	}()

	// A temp file is created 0600 because it is a temp file. That is not a
	// decision about the document, which is an ordinary user file.
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}

	m := manifestFor(d)

	zw := zip.NewWriter(tmp)
	if err = writeEntries(zw, d, m); err != nil {
		return err
	}
	if err = zw.Close(); err != nil { // flushes the central directory
		return err
	}
	if err = tmp.Sync(); err != nil { // durable before the swap, not after
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}

	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}

	// The measured manifest goes back to the caller, so the next save preserves
	// the time of the first one and the status bar can report what was written.
	// Only a save that landed gets to claim it.
	d.Manifest = m
	return nil
}

// writeEntries lays out the container. The source goes in byte for byte: uno has
// no opinion about your file's line endings or quoting and must not acquire one
// by round-tripping it.
func writeEntries(zw *zip.Writer, d *Document, m Manifest) error {
	if err := writeJSON(zw, manifestEntry, m, m.Modified); err != nil {
		return err
	}

	w, err := create(zw, m.Source.Entry, m.Modified)
	if err != nil {
		return err
	}
	if _, err = w.Write(d.Raw); err != nil {
		return err
	}

	if err := writeJSON(zw, stateEntry, d.State, m.Modified); err != nil {
		return err
	}
	if err := writeLog(zw, logEntry, d.Edits, m.Modified); err != nil {
		return err
	}
	return writeExtra(zw, d.Extra, m.Modified)
}

// manifestFor measures the container from the container. Everything the file
// says about itself — the sizes, the hash, the counts, the entry names, the
// version — is taken from what is actually being written, so no code path can
// produce a manifest describing a different file. What the caller supplies is
// what the writer cannot see: where the bytes came from, when the document was
// first saved, and the shape of the sheet the log builds.
func manifestFor(d *Document) Manifest {
	sum := sha256.Sum256(d.Raw)

	m := d.Manifest
	m.Format = versionFor(d.Edits)
	m.Generator = generator
	m.Modified = time.Now().UTC().Truncate(time.Second)
	if m.Created.IsZero() {
		m.Created = m.Modified
	}

	m.Source.Bytes = len(d.Raw)
	m.Source.SHA256 = hex.EncodeToString(sum[:])
	m.Source.Entry = sourceEntry(m.Source.Name)

	m.Sheet.Entry = stateEntry
	m.Edits.Entry = logEntry
	m.Edits.Count = len(d.Edits)
	return m
}

// versionFor is the oldest build that could replay this log. An operation an
// older uno does not know is not a thing to fail on halfway through a replay, so
// a file carrying one says so in the manifest and Read refuses it by name before
// a single entry is decoded.
func versionFor(edits []sheet.Edit) int {
	for _, e := range edits {
		if e.Op != sheet.OpSet {
			return formatVersion
		}
	}
	return baseVersion
}

// create adds a deflated entry stamped with the save time. zip.Writer.Create
// leaves the timestamp at zero, which unzip -l renders as 1980-00-00, and a
// container meant to be inspected without uno should not list nonsense dates.
func create(zw *zip.Writer, name string, at time.Time) (io.Writer, error) {
	return zw.CreateHeader(&zip.FileHeader{
		Name:     name,
		Method:   zip.Deflate, // Create's default; Store would not compress
		Modified: at,
	})
}

func writeJSON(zw *zip.Writer, name string, v any, at time.Time) error {
	w, err := create(zw, name, at)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ") // a person opening the zip should be able to read it
	return enc.Encode(v)
}

// writeLog writes one operation per line. JSONL and not JSON because a line
// appends without rewriting what came before, stays readable in a diff, and
// survives a truncated tail: a log cut short still replays up to its last
// complete line.
func writeLog(zw *zip.Writer, name string, edits []sheet.Edit, at time.Time) error {
	w, err := create(zw, name, at)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w) // Encode terminates each value with a newline
	for _, e := range edits {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

// writeExtra puts back the entries this build did not understand. They are
// written in name order rather than in map order, so the layout of a saved file
// does not shuffle between saves that changed nothing.
func writeExtra(zw *zip.Writer, extra map[string][]byte, at time.Time) error {
	names := make([]string, 0, len(extra))
	for name := range extra {
		names = append(names, name)
	}
	slices.Sort(names)

	for _, name := range names {
		w, err := create(zw, name, at)
		if err != nil {
			return err
		}
		if _, err := w.Write(extra[name]); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}
