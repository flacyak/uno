package library

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// unitMargin is the formula from the design doc, the one a person is most
// likely to have written first.
func unitMargin() Formula {
	return Formula{
		ID:   "unit-margin",
		Name: "Unit margin",
		Kind: KindColumn,
		Expr: "(price - cost) / price",
		Refs: []string{"price", "cost"},
	}
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", filepath.Base(path), err)
	}
	return b
}

// A formula is a file so that it can be sent to someone, which is only worth
// anything if what comes back out is what went in.
func TestASavedFormulaReadsBackWithEveryFieldIntact(t *testing.T) {
	dir := t.TempDir()
	f := unitMargin()

	if err := Save(dir, f); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Read(filepath.Join(dir, "unit-margin.unof"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if got.Created.IsZero() || got.Modified.IsZero() {
		t.Errorf("created = %v, modified = %v, want both stamped", got.Created, got.Modified)
	}
	want := f
	want.Format = formatVersion
	want.Created, want.Modified = got.Created, got.Modified
	if !reflect.DeepEqual(got, want) {
		t.Errorf("read back\n %+v\nwant\n %+v", got, want)
	}
}

// A formula was written once and is edited many times. The first of those facts
// is the one an autosave must not overwrite with the second.
func TestResavingKeepsTheTimeTheFormulaWasFirstWritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unit-margin.unof")

	if err := Save(dir, unitMargin()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	first, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	edited := first
	edited.Expr = "(price - cost) / cost"
	if err := Save(dir, edited); err != nil {
		t.Fatalf("resave: %v", err)
	}
	again, err := Read(path)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}

	if !again.Created.Equal(first.Created) {
		t.Errorf("created = %v, want the first save's %v", again.Created, first.Created)
	}
	if again.Modified.Before(first.Modified) {
		t.Errorf("modified = %v, went backwards from %v", again.Modified, first.Modified)
	}
	if again.Expr != edited.Expr {
		t.Errorf("expr = %q, want the edit %q", again.Expr, edited.Expr)
	}
}

// A notation formula reads no columns, so its file says nothing about columns.
// An empty refs list would still be a claim that it could have some, which is
// why this reads the bytes rather than the decoded value.
func TestANotationFormulaCarriesNoRefsKeyAtAll(t *testing.T) {
	dir := t.TempDir()

	err := Save(dir, Formula{
		ID:   "std-deviation",
		Name: "Std. deviation",
		Kind: KindNotation,
		Expr: `\sigma = \sqrt{\frac{1}{n}\sum_{i=1}^{n}(x_i - \mu)^2}`,
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	b := read(t, filepath.Join(dir, "std-deviation.unof"))
	if strings.Contains(string(b), "refs") {
		t.Errorf("a notation formula wrote a refs key:\n%s", b)
	}

	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := keys["refs"]; ok {
		t.Error("refs survived as a key")
	}
}

// An older uno opening a file a newer one wrote must carry what it could not
// read through to the next save. Dropping it would mean this build silently
// deleting a stranger's work every time it autosaved their formula.
func TestKeysThisBuildDoesNotKnowSurviveASaveAndRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unit-margin.unof")

	// Written by hand, as a newer uno would have written it.
	handmade := `{
  "format": 1,
  "id": "unit-margin",
  "name": "Unit margin",
  "kind": "column",
  "expr": "(price - cost) / price",
  "refs": ["price", "cost"],
  "created": "2026-08-31T09:14:02Z",
  "modified": "2026-08-31T16:41:55Z",
  "tolerance": 0.001,
  "provenance": {"by": "a newer uno", "rounds": 3}
}`
	if err := os.WriteFile(path, []byte(handmade), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Read, save, read, save: the second cycle is where a build that only kept
	// unknown keys in memory would lose them.
	for cycle := range 2 {
		f, err := Read(path)
		if err != nil {
			t.Fatalf("cycle %d: Read: %v", cycle, err)
		}
		if err := Save(dir, f); err != nil {
			t.Fatalf("cycle %d: Save: %v", cycle, err)
		}

		var got map[string]any
		if err := json.Unmarshal(read(t, path), &got); err != nil {
			t.Fatalf("cycle %d: unmarshal: %v", cycle, err)
		}
		if got["tolerance"] != 0.001 {
			t.Errorf("cycle %d: tolerance = %v, want 0.001", cycle, got["tolerance"])
		}
		prov, ok := got["provenance"].(map[string]any)
		if !ok {
			t.Fatalf("cycle %d: provenance = %v, want the object it was", cycle, got["provenance"])
		}
		if prov["by"] != "a newer uno" || prov["rounds"] != float64(3) {
			t.Errorf("cycle %d: provenance = %v, want it whole", cycle, prov)
		}
		// The keys it does know are still written once each, not twice.
		if n := strings.Count(string(read(t, path)), `"expr"`); n != 1 {
			t.Errorf("cycle %d: expr appears %d times, want 1", cycle, n)
		}
	}
}

// The autosave writes while someone is typing, which is when a crash is most
// likely. An interrupted one must cost the keystroke, never the formula that
// was already saved — the same promise safefile makes to the .uno container.
func TestAFailedSaveLeavesThePreviousFormulaWhole(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unit-margin.unof")

	if err := Save(dir, unitMargin()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	saved := read(t, path)

	// A formula that cannot be encoded at all: the failure lands mid-save, with
	// the previous file sitting on disk beside it.
	broken := unitMargin()
	broken.Expr = "the new one"
	broken.Extra = map[string]json.RawMessage{"nonsense": json.RawMessage("not json")}
	if err := Save(dir, broken); err == nil {
		t.Fatal("want a failure, got nil")
	}

	if got := read(t, path); string(got) != string(saved) {
		t.Errorf("the previous formula changed:\n%s\nwant\n%s", got, saved)
	}
	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(left) != 1 || left[0].Name() != "unit-margin.unof" {
		t.Errorf("directory holds %v, want only the formula", left)
	}
}

// The id becomes a filename, so it is the one field in a .unof that can reach
// outside the library. Formulas arrive from other people, so this is a trust
// boundary and not a formality.
func TestAnIDThatCouldNameAPathIsRefused(t *testing.T) {
	for _, id := range []string{
		"",
		"../escape",
		"a/b",
		`a\b`,
		".",
		"..",
		"...",
		".hidden",
		"c:margin",
		"unit\nmargin",
		strings.Repeat("x", maxIDLen+1),
	} {
		dir := t.TempDir()
		f := unitMargin()
		f.ID = id

		if err := Save(dir, f); err == nil {
			t.Errorf("id %q was accepted", id)
		}

		// Nothing was written anywhere, including beside the directory rather
		// than in it, which is what an escaping id would have managed.
		for _, look := range []string{dir, filepath.Dir(dir)} {
			entries, err := os.ReadDir(look)
			if err != nil {
				t.Fatalf("read dir: %v", err)
			}
			for _, e := range entries {
				if strings.HasSuffix(e.Name(), ext) {
					t.Errorf("id %q wrote %s", id, filepath.Join(look, e.Name()))
				}
			}
		}
	}
}

// A .unof holds no path for the reason a .uno holds none: a file that only
// works where it was written is not reusable anywhere, and the whole point of
// one file per formula is that the file can be sent to someone else.
func TestAFormulaCarriesNoPathFromTheMachineThatWroteIt(t *testing.T) {
	dir := t.TempDir()

	if err := Save(dir, unitMargin()); err != nil {
		t.Fatalf("Save: %v", err)
	}

	b := string(read(t, filepath.Join(dir, "unit-margin.unof")))
	for _, path := range []string{dir, filepath.Dir(dir), os.TempDir()} {
		if strings.Contains(b, path) {
			t.Errorf("the file names %s:\n%s", path, b)
		}
	}
	// No value in the file begins with a separator either. A division reads as
	// "a / b" and never as "\"/", so this catches an absolute path without
	// catching the arithmetic.
	if strings.Contains(b, `"`+string(filepath.Separator)) {
		t.Errorf("the file holds an absolute path:\n%s", b)
	}
}

// One file per formula is worth having only if one bad file is one formula. A
// library that refused to open because a single .unof was truncated would have
// given away the thing that made the layout worth choosing.
func TestOneUnreadableFileCostsOneFormulaAndNotTheLibrary(t *testing.T) {
	dir := t.TempDir()

	for _, id := range []string{"unit-margin", "strip-thousands"} {
		f := unitMargin()
		f.ID, f.Name = id, id
		if err := Save(dir, f); err != nil {
			t.Fatalf("Save %s: %v", id, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "truncated.unof"), []byte(`{"id": "trunc`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Not a formula, and not this package's business either way.
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := Load(dir)
	if err == nil {
		t.Error("the truncated file was not reported")
	} else if !strings.Contains(err.Error(), "truncated.unof") {
		t.Errorf("error = %v, want it to name the file", err)
	}

	var ids []string
	for _, f := range got {
		ids = append(ids, f.ID)
	}
	// Sorted, because the order a directory hands back is not an order.
	if want := []string{"strip-thousands", "unit-margin"}; !reflect.DeepEqual(ids, want) {
		t.Errorf("loaded %v, want %v", ids, want)
	}
}

// A person who has never written a formula has no folder, which is not a fault
// to report to them.
func TestALibraryThatDoesNotExistYetIsEmptyRatherThanBroken(t *testing.T) {
	got, err := Load(filepath.Join(t.TempDir(), "formulas"))
	if err != nil {
		t.Errorf("Load: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("loaded %v, want nothing", got)
	}
}

// A build that guessed at a layout it does not know would either misread the
// file or save what it misread back over it, and the person would be told
// neither.
func TestAFormulaFromANewerUnoIsRefusedByName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "unit-margin.unof")

	newer := `{"format": 99, "id": "unit-margin", "name": "Unit margin", "kind": "column", "expr": "1"}`
	if err := os.WriteFile(path, []byte(newer), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	_, err := Read(path)
	if err == nil {
		t.Fatal("want a refusal, got nil")
	}
	if !strings.Contains(err.Error(), "unit-margin.unof") || !strings.Contains(err.Error(), "99") {
		t.Errorf("error = %v, want it to name the file and the format", err)
	}
}

// A file whose id names a path is a file this package must not hand out, so the
// check happens on the way in as well as on the way out.
func TestAFileWhoseIDNamesAPathIsRefusedOnRead(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "escape.unof")

	if err := os.WriteFile(path, []byte(`{"format": 1, "id": "../escape", "kind": "column"}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := Read(path); err == nil {
		t.Fatal("want a refusal, got nil")
	}
}

// The times are written the way the .uno manifest writes them: UTC, whole
// seconds, so a diff between two saves shows what changed rather than a
// nanosecond nobody typed.
func TestTheTimesAreWrittenAsWholeSecondsInUTC(t *testing.T) {
	dir := t.TempDir()

	if err := Save(dir, unitMargin()); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var got struct {
		Created  string `json:"created"`
		Modified string `json:"modified"`
	}
	if err := json.Unmarshal(read(t, filepath.Join(dir, "unit-margin.unof")), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, stamp := range []string{got.Created, got.Modified} {
		if _, err := time.Parse("2006-01-02T15:04:05Z", stamp); err != nil {
			t.Errorf("stamp %q is not a whole second in UTC: %v", stamp, err)
		}
	}
}

// Markdown was chosen so a .unof stays legible to someone reading it in a diff
// or a chat window without uno. A comparison rewritten as < would take
// that back one character at a time.
func TestAComparisonIsWrittenAsItWasTyped(t *testing.T) {
	dir := t.TempDir()
	f := unitMargin()
	f.Expr = "price < cost & margin > 0"

	if err := Save(dir, f); err != nil {
		t.Fatalf("Save: %v", err)
	}

	b := string(read(t, filepath.Join(dir, "unit-margin.unof")))
	if !strings.Contains(b, f.Expr) {
		t.Errorf("the expression was rewritten:\n%s", b)
	}
	got, err := Read(filepath.Join(dir, "unit-margin.unof"))
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Expr != f.Expr {
		t.Errorf("expr = %q, want %q", got.Expr, f.Expr)
	}
}
