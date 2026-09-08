package library

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Read loads one .unof. Nothing outside the file is consulted, which is what
// lets a formula somebody sent you open on a machine that has never had a
// library at all.
func Read(path string) (Formula, error) {
	name := filepath.Base(path)

	b, err := os.ReadFile(path)
	if err != nil {
		return Formula{}, err
	}

	var f Formula
	if err := json.Unmarshal(b, &f); err != nil {
		return Formula{}, fmt.Errorf("%s is not a readable .unof file: %w", name, err)
	}
	// A reader that guesses at a layout it does not know will either misread it
	// or, far worse, save what it misread back over the file.
	if f.Format > formatVersion {
		return Formula{}, fmt.Errorf(
			"%s was saved by a newer uno (format %d, this build reads %d). Update uno to open it",
			name, f.Format, formatVersion)
	}
	// The id is checked on the way in as well as on the way out, so no id that
	// could name a path is ever handed to a caller in the first place.
	if err := validID(f.ID); err != nil {
		return Formula{}, fmt.Errorf("%s: %w", name, err)
	}
	return f, nil
}

// Load reads every .unof in dir.
//
// One bad file costs one formula and not the library: Load returns everything it
// could read, and alongside it a joined error naming each file it could not, so
// the drawer still opens with the other seventeen formulas in it and the caller
// still has something specific to say about the missing one. Both return values
// are meant to be used; a non-nil error here does not mean the slice is empty.
//
// A directory that does not exist is an empty library rather than a failure. A
// person who has never written a formula has no folder, and that is not a fault
// worth reporting to them.
func Load(dir string) ([]Formula, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	var formulas []Formula
	var bad []error
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ext) {
			continue
		}
		f, err := Read(filepath.Join(dir, e.Name()))
		if err != nil {
			bad = append(bad, err)
			continue
		}
		formulas = append(formulas, f)
	}

	// Sorted by id, so the caller is handed a stable order instead of whatever
	// the directory happened to give. Which order they are shown in is the
	// caller's decision: recency is a fact about this person on this machine and
	// is deliberately not in these files.
	slices.SortFunc(formulas, func(a, b Formula) int { return strings.Compare(a.ID, b.ID) })
	return formulas, errors.Join(bad...)
}
