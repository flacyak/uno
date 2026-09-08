// Package library reads and writes the .unof files a person's formulas live in,
// one file per formula.
//
// A library could as easily be a single file holding all of them, and should not
// be. One file per formula makes the shareable unit the same as the editable
// unit: sending someone a formula is sending a file, edit beside a name opens
// that file, and an autosave on every keystroke rewrites 400 bytes rather than
// the whole library, so a bad write costs one formula instead of forty.
//
// The directory is an argument and never a lookup. Where formulas live is
// app.Storage()'s business, and resolving it here would put a Fyne call in a
// package that has no business making one; taking a path instead is what lets
// every test below run with no display attached (I-6). Debouncing the autosave
// and handing the result back to the UI goroutine belong to internal/ui as well:
// everything here is synchronous and touches nothing but the filesystem.
package library

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"time"
)

// formatVersion is the highest layout this build reads, and the one it writes. A
// .unof is meant to travel — it is the whole reason a formula is a file — so the
// number is part of the promise made to whoever receives one.
const formatVersion = 1

// ext is the extension both kinds of formula share. They have almost nothing
// else in common, but they open from the same drawer, so they save the same way.
const ext = ".unof"

// Kind is which of the two things wearing the word "formula" this is.
type Kind string

const (
	// KindColumn binds arithmetic to a whole column. It reads other columns,
	// recalculates when they change, and can take part in a cycle.
	KindColumn Kind = "column"
	// KindNotation is markdown placed in one cell. It reads nothing, depends on
	// nothing, and never changes again until a person edits it.
	KindNotation Kind = "notation"
)

// Formula is one .unof.
//
// What is absent is as decided as what is here. There is no usage history:
// "recently used" is an ordering that belongs to this person on this machine,
// and shipping it inside the formula would mean sending your habits along with
// your arithmetic every time you shared one — the caller keeps recency in
// app.Preferences(). There are no paths either, for the reason a .uno has none:
// a file that only works where it was written is not reusable anywhere.
type Formula struct {
	Format int    `json:"format"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   Kind   `json:"kind"`
	// Expr is arithmetic for a column formula and markdown for a notation one.
	// Markdown, because a .unof is meant to be shared and markdown stays legible
	// to someone reading the file without uno: in a diff, in a chat window, in a
	// text editor.
	Expr string `json:"expr"`
	// Refs names the columns the expression reads, by name and resolved on
	// apply, because a column's position is a fact about one sheet rather than
	// about the formula. A notation formula reads nothing, so it carries no refs
	// key at all rather than an empty list that would imply it could.
	Refs     []string  `json:"refs,omitempty"`
	Created  time.Time `json:"created"`
	Modified time.Time `json:"modified"`

	// Extra carries the keys this build did not recognise through to the next
	// save. An older uno opening a file written by a newer one must not quietly
	// drop what it could not read and then write that loss back over the file —
	// the same rule internal/document keeps for entries it does not know. A
	// plain struct unmarshal drops them, which is why this type does its own.
	Extra map[string]json.RawMessage `json:"-"`
}

// knownKeys is derived from the struct tags rather than written out beside them,
// so a field added later cannot be forgotten here and end up written twice: once
// from the struct and once again out of Extra.
var knownKeys = func() map[string]bool {
	t := reflect.TypeOf(Formula{})
	keys := make(map[string]bool, t.NumField())
	for i := range t.NumField() {
		name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			keys[name] = true
		}
	}
	return keys
}()

// UnmarshalJSON fills the fields this build knows and keeps everything else
// beside them. Decoding twice — once into the struct, once into a map — is what
// makes the unrecognised keys visible at all; the struct alone cannot see them.
func (f *Formula) UnmarshalJSON(b []byte) error {
	type known Formula // a defined type carries no methods, so this does not recurse

	var k known
	if err := json.Unmarshal(b, &k); err != nil {
		return err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return err
	}
	for name := range all {
		if knownKeys[name] {
			delete(all, name)
		}
	}
	if len(all) == 0 {
		all = nil // an ordinary file gets no empty map to carry around
	}

	*f = Formula(k)
	f.Extra = all
	return nil
}

// MarshalJSON writes the known fields in the order they are declared and then
// the unrecognised ones, in name order rather than map order so that a save that
// changed nothing produces the same bytes as the one before it.
//
// The unknown keys are appended to the encoded object rather than merged into a
// map with the known ones, because a map would sort every key together and
// reorder a file that a person is expected to read.
func (f Formula) MarshalJSON() ([]byte, error) {
	type known Formula

	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	// A comparison in an expression stays a "<" rather than becoming a
	// "\u003c". Escaping it would cost exactly the legibility that made
	// markdown the right thing to store, and json.Marshal cannot be asked.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(known(f)); err != nil {
		return nil, err
	}
	b := bytes.TrimRight(out.Bytes(), "\n")
	if len(f.Extra) == 0 {
		return b, nil
	}

	names := make([]string, 0, len(f.Extra))
	for name := range f.Extra {
		if !knownKeys[name] { // a key this build owns is never written from Extra
			names = append(names, name)
		}
	}
	slices.Sort(names)

	var buf bytes.Buffer
	buf.Write(b[:len(b)-1]) // everything but the closing brace
	for _, name := range names {
		key, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		if buf.Len() > 1 {
			buf.WriteByte(',')
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(f.Extra[name])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// maxIDLen is short of the 255 bytes filesystems stop at, leaving room for the
// extension. The limit is here so the refusal names the id rather than arriving
// from the kernel as ENAMETOOLONG halfway through an autosave.
const maxIDLen = 200

// fileName is the only place an id becomes a path, and validID is the only thing
// standing between the two.
func fileName(id string) (string, error) {
	if err := validID(id); err != nil {
		return "", err
	}
	return id + ext, nil
}

// validID checks the one value in a .unof that can reach outside the directory
// it was read from. Formulas arrive from other people — that is the point of
// making each one a file — so the id is checked before it is joined to a path,
// never after, and both separators are refused on every platform because a file
// written on Windows is expected to open here.
func validID(id string) error {
	if id == "" {
		return errors.New("a formula with no id has no file to be saved in")
	}
	if len(id) > maxIDLen {
		return fmt.Errorf("formula id %q is %d bytes, longer than a filename may be", id, len(id))
	}
	// A leading dot covers "." and ".." without naming them, hides the file from
	// the person who owns it, and keeps an id away from the .uno-*.part temp
	// files safefile is in the middle of renaming.
	if strings.HasPrefix(id, ".") {
		return fmt.Errorf("formula id %q may not start with a dot", id)
	}
	for _, r := range id {
		switch {
		case r == '/' || r == '\\' || r == ':':
			return fmt.Errorf("formula id %q may not name a path", id)
		case r < 0x20 || r == 0x7f:
			return fmt.Errorf("formula id %q contains a control character", id)
		}
	}
	return nil
}
