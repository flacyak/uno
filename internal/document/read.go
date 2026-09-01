package document

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"

	"github.com/flacyak/uno/internal/ingest"
	"github.com/flacyak/uno/internal/sheet"
)

// Read restores a document from a .uno. Nothing outside the container is
// consulted: no original file, no stored path, no network. That is what lets the
// file open on a machine that has never seen the CSV it was made from.
func Read(path string) (*Document, error) {
	name := filepath.Base(path)

	// zip.OpenReader verifies each entry's CRC-32 as it is read, so a corrupted
	// container fails here rather than halfway through building a sheet.
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("%s is not a readable .uno file: %w", name, err)
	}
	defer zr.Close()

	var m Manifest
	if err := readJSON(&zr.Reader, manifestEntry, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	// A reader that guesses at a layout it does not know will either crash or,
	// far worse, silently drop the entries it did not recognise and then save
	// that loss back over the original.
	if m.Format > formatVersion {
		return nil, fmt.Errorf(
			"%s was saved by a newer uno (format %d, this build reads %d). Update uno to open it",
			name, m.Format, formatVersion)
	}

	raw, err := readAll(&zr.Reader, m.Source.Entry)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	// The same call a plain CSV takes. One way to build a sheet is the only
	// reason a restored workspace is guaranteed to match the one that was saved.
	sh, err := ingest.Read(m.Source.Name, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%s: embedded %s: %w", name, m.Source.Name, err)
	}

	edits, err := readLog(&zr.Reader, m.Edits.Entry)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if err := sh.Replay(edits); err != nil {
		return nil, fmt.Errorf("%s: replaying edits: %w", name, err)
	}

	var state State
	if err := readJSON(&zr.Reader, m.Sheet.Entry, &state); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	return &Document{
		Manifest: m,
		Raw:      raw,
		State:    state,
		Edits:    edits,
		Extra:    readExtra(&zr.Reader, m),
		Sheet:    sh,
	}, nil
}

func open(zr *zip.Reader, name string) (io.ReadCloser, error) {
	if name == "" {
		return nil, fmt.Errorf("the manifest names no entry for this part of the file")
	}
	rc, err := zr.Open(name)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return rc, nil
}

func readAll(zr *zip.Reader, name string) ([]byte, error) {
	rc, err := open(zr, name)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	b, err := io.ReadAll(rc) // a CRC mismatch surfaces here
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return b, nil
}

func readJSON(zr *zip.Reader, name string, v any) error {
	b, err := readAll(zr, name)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// readLog reads the operations in order and tolerates exactly one thing: a final
// line cut in half. Anything unparseable earlier in the file is a log that has
// been damaged in the middle, where stopping would silently discard the
// operations after it, so that is an error.
func readLog(zr *zip.Reader, name string) ([]sheet.Edit, error) {
	b, err := readAll(zr, name)
	if err != nil {
		return nil, err
	}

	lines := bytes.Split(b, []byte{'\n'})
	edits := make([]sheet.Edit, 0, len(lines))
	for i, line := range lines {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e sheet.Edit
		if err := json.Unmarshal(line, &e); err != nil {
			if i == len(lines)-1 {
				break // a truncated tail costs the last operation, at worst
			}
			return nil, fmt.Errorf("%s line %d: %w", name, i+1, err)
		}
		edits = append(edits, e)
	}
	return edits, nil
}

// readExtra keeps whatever this build did not recognise, so it survives to the
// next save. Version skew is only survivable if an older uno hands back the
// entries it could not read.
func readExtra(zr *zip.Reader, m Manifest) map[string][]byte {
	known := map[string]bool{
		manifestEntry:  true,
		m.Source.Entry: true,
		m.Sheet.Entry:  true,
		m.Edits.Entry:  true,
	}

	var extra map[string][]byte
	for _, f := range zr.File {
		if known[f.Name] || f.FileInfo().IsDir() {
			continue
		}
		// An unreadable unknown entry is not worth failing the open over: it is
		// not something this build was going to use. Dropping it is the cost.
		b, err := readAll(zr, f.Name)
		if err != nil {
			continue
		}
		if extra == nil {
			extra = map[string][]byte{}
		}
		extra[f.Name] = b
	}
	return extra
}
