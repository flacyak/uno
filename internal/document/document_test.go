package document

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/flacyak/uno/internal/ingest"
	"github.com/flacyak/uno/internal/program"
	"github.com/flacyak/uno/internal/sheet"
)

const csvBody = "date,region,units\n2026-07-01,West,\"1,204\"\n2026-07-01,East,987\n" +
	"2026-07-02,North,\"1,455\"\n"

// saved writes a workspace to a temp .uno and returns its path. Everything here
// runs with no display attached, which is the point of keeping the container out
// of ui (I-6).
func saved(t *testing.T, name string, edit func(*sheet.Sheet)) (string, *Document) {
	t.Helper()

	sh, err := ingest.Read(name, strings.NewReader(csvBody))
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if edit != nil {
		edit(sh)
	}

	d := &Document{
		Manifest: Manifest{
			Source: Source{Name: name},
			Sheet:  SheetRef{Rows: sh.Rows(), Cols: sh.Cols()},
		},
		Raw:   []byte(csvBody),
		State: State{Active: Cell{Row: 2, Col: 1}},
		Edits: sh.Edits(),
	}

	path := filepath.Join(t.TempDir(), unoFor(name))
	if err := Write(path, d); err != nil {
		t.Fatalf("Write: %v", err)
	}
	return path, d
}

func unoFor(name string) string {
	return strings.TrimSuffix(name, filepath.Ext(name)) + ".uno"
}

func entryNames(t *testing.T, path string) []string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	defer zr.Close()

	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	return names
}

// The whole milestone: a file that opens on a machine that has never seen the
// CSV, with the edits made before the save already applied.
func TestRoundTripRebuildsTheWorkspace(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", func(sh *sheet.Sheet) {
		if err := sh.Set(0, 2, "1204"); err != nil {
			t.Fatalf("Set: %v", err)
		}
		if err := sh.Set(2, 2, "1455"); err != nil {
			t.Fatalf("Set: %v", err)
		}
	})

	doc, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	if !bytes.Equal(doc.Raw, []byte(csvBody)) {
		t.Error("the embedded source is not the bytes that went in")
	}
	if got := doc.Sheet.At(0, 2); got != "1204" {
		t.Errorf("cell = %q, want the log replayed over the raw bytes", got)
	}
	if got := doc.Sheet.At(1, 2); got != "987" {
		t.Errorf("untouched cell = %q, want it to come from the raw bytes", got)
	}
	if doc.Sheet.EditCount() != 2 {
		t.Errorf("edits = %d, want the log kept for the next save", doc.Sheet.EditCount())
	}
	if doc.State.Active != (Cell{Row: 2, Col: 1}) {
		t.Errorf("active cell = %+v, want it restored", doc.State.Active)
	}
	// The replayed values parse, so the column is a number column again.
	if c := doc.Sheet.Columns[2]; c.Kind != sheet.KindNum || c.Flagged {
		t.Errorf("units reopened as %v flagged=%v, want an unflagged num column",
			c.Kind, c.Flagged)
	}
}

// The format is inspectable without uno: anyone can unzip a suspect file and see
// what is in it. A TSV's bytes are named after the TSV, not after a CSV.
func TestTheContainerHoldsFourNamedEntries(t *testing.T) {
	path, _ := saved(t, "inventory.tsv", nil)

	want := []string{"uno.json", "data/source.tsv", "sheet/state.json", "edits/log.jsonl"}
	got := entryNames(t, path)
	if len(got) != len(want) {
		t.Fatalf("entries = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("entry %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// The manifest describes the container it is in, so it is measured from what was
// written rather than supplied by a caller that could be wrong.
func TestTheManifestIsMeasuredFromTheBytes(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)

	doc, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	m := doc.Manifest

	// This log is single-cell edits and nothing else, so the file says the
	// oldest build that could replay it rather than the one that wrote it.
	if m.Format != baseVersion {
		t.Errorf("format = %d, want %d", m.Format, baseVersion)
	}
	if m.Source.Bytes != len(csvBody) {
		t.Errorf("source bytes = %d, want %d", m.Source.Bytes, len(csvBody))
	}
	if len(m.Source.SHA256) != 64 {
		t.Errorf("sha256 = %q, want a 64-character digest", m.Source.SHA256)
	}
	if m.Sheet.Rows != 3 || m.Sheet.Cols != 3 {
		t.Errorf("sheet = %dx%d, want the 3x3 the log builds", m.Sheet.Rows, m.Sheet.Cols)
	}
	if m.Edits.Count != 0 {
		t.Errorf("edits count = %d, want 0", m.Edits.Count)
	}
	if m.Source.Name != "sales-q3.csv" {
		t.Errorf("source name = %q, want the file the bytes came from", m.Source.Name)
	}
	if m.Created.IsZero() || m.Modified.IsZero() {
		t.Errorf("timestamps = %v / %v, want both set", m.Created, m.Modified)
	}
	// A path is precisely the thing that stops being true when the file travels.
	if strings.ContainsRune(m.Source.Name, filepath.Separator) {
		t.Errorf("source name = %q, want a name and not a path", m.Source.Name)
	}
}

// A save preserves when the document was first written, so reopening and saving
// again does not keep resetting its age.
func TestASecondSaveKeepsTheCreatedTime(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)

	first, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if err := Write(path, first); err != nil {
		t.Fatalf("second Write: %v", err)
	}

	second, err := Read(path)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if !second.Manifest.Created.Equal(first.Manifest.Created) {
		t.Errorf("created = %v, want the first save's %v",
			second.Manifest.Created, first.Manifest.Created)
	}
}

// A reader that guesses at a layout it does not know will either crash or
// silently drop what it did not recognise, so it refuses and names both versions.
func TestANewerFormatIsRefusedByName(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)
	rewriteManifest(t, path, func(m *Manifest) { m.Format = formatVersion + 1 })

	_, err := Read(path)
	if err == nil {
		t.Fatal("want a refusal, got nil")
	}
	for _, want := range []string{"sales-q3.uno", "format 3", "reads 2"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// Version skew is only survivable if an older uno hands back the entries it
// could not read instead of writing that loss over the file.
func TestAnUnknownEntrySurvivesARoundTrip(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)
	addEntry(t, path, "charts/1.json", []byte(`{"kind":"bar"}`))

	doc, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got := string(doc.Extra["charts/1.json"]); got != `{"kind":"bar"}` {
		t.Fatalf("unknown entry read back as %q", got)
	}

	if err := Write(path, doc); err != nil {
		t.Fatalf("re-Write: %v", err)
	}
	again, err := Read(path)
	if err != nil {
		t.Fatalf("re-Read: %v", err)
	}
	if got := string(again.Extra["charts/1.json"]); got != `{"kind":"bar"}` {
		t.Errorf("unknown entry after a round trip = %q, want it carried through", got)
	}
}

// A truncated tail costs the last operation at worst; the rest still replays.
func TestATruncatedLogReplaysItsCompleteLines(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", func(sh *sheet.Sheet) {
		if err := sh.Set(0, 2, "1204"); err != nil {
			t.Fatalf("Set: %v", err)
		}
		if err := sh.Set(2, 2, "1455"); err != nil {
			t.Fatalf("Set: %v", err)
		}
	})

	rewriteEntry(t, path, logEntry, func(b []byte) []byte {
		return b[:len(b)-12] // cut the last line in half
	})

	doc, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got := doc.Sheet.At(0, 2); got != "1204" {
		t.Errorf("first edit = %q, want it replayed", got)
	}
	if got := doc.Sheet.At(2, 2); got != "1,455" {
		t.Errorf("cut edit = %q, want the raw value", got)
	}
}

// A flipped byte inside the container must fail the open, not produce a wrong grid.
func TestACorruptedEntryFailsTheOpen(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)

	for _, name := range entryNames(t, path) {
		t.Run(name, func(t *testing.T) {
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			b[dataOffset(t, path, name)] ^= 0xff
			flipped := filepath.Join(t.TempDir(), "flipped.uno")
			if err := os.WriteFile(flipped, b, 0o600); err != nil {
				t.Fatalf("write: %v", err)
			}

			if _, err := Read(flipped); err == nil {
				t.Error("want a failure, got nil")
			}
		})
	}
}

// A save that cannot be completed must leave nothing behind, so the directory
// beside a good .uno never fills with half-written parts.
func TestAFailedWriteLeavesNoDebris(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sales-q3.uno")

	// An entry name a zip cannot hold is the cheapest way to fail mid-archive.
	d := &Document{
		Manifest: Manifest{Source: Source{Name: "sales-q3.csv"}},
		Raw:      []byte(csvBody),
		Extra:    map[string][]byte{strings.Repeat("x", 1<<17): {}},
	}
	if err := Write(path, d); err == nil {
		t.Fatal("want a failure, got nil")
	}

	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range left {
		t.Errorf("left behind %q", e.Name())
	}
}

// An interrupted save must lose the new data rather than the data already saved,
// which is what the temp-and-rename buys.
func TestAFailedWriteLeavesThePreviousSaveWhole(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", nil)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	bad := &Document{
		Manifest: Manifest{Source: Source{Name: "sales-q3.csv"}},
		Raw:      []byte(csvBody),
		Extra:    map[string][]byte{strings.Repeat("x", 1<<17): {}},
	}
	if err := Write(path, bad); err == nil {
		t.Fatal("want a failure, got nil")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the previous save is gone: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Error("the previous save was modified by a failed write")
	}
	if _, err := Read(path); err != nil {
		t.Errorf("the previous save no longer opens: %v", err)
	}
}

// dataOffset is where an entry's compressed bytes start in the file, so a test
// can damage the payload rather than a byte that happens to be padding.
func dataOffset(t *testing.T, path, name string) int64 {
	t.Helper()

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	defer zr.Close()

	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		off, err := f.DataOffset()
		if err != nil {
			t.Fatalf("data offset for %s: %v", name, err)
		}
		return off
	}
	t.Fatalf("no entry named %s", name)
	return 0
}

// rewriteEntry rebuilds a .uno with one entry replaced, which is how the damaged
// files above are produced without hand-rolling a zip.
func rewriteEntry(t *testing.T, path, name string, fn func([]byte) []byte) {
	t.Helper()

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer zr.Close()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		src, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := io.ReadAll(src)
		src.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		if f.Name == name {
			b = fn(b)
		}
		w, err := zw.Create(f.Name)
		if err != nil {
			t.Fatalf("create %s: %v", f.Name, err)
		}
		if _, err := w.Write(b); err != nil {
			t.Fatalf("write %s: %v", f.Name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("replace: %v", err)
	}
}

func rewriteManifest(t *testing.T, path string, fn func(*Manifest)) {
	t.Helper()
	rewriteEntry(t, path, manifestEntry, func(b []byte) []byte {
		var m Manifest
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("manifest: %v", err)
		}
		fn(&m)
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("manifest: %v", err)
		}
		return out
	})
}

// addEntry appends an entry this build knows nothing about, standing in for one
// written by a later uno.
func addEntry(t *testing.T, path, name string, body []byte) {
	t.Helper()

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		src, _ := f.Open()
		b, _ := io.ReadAll(src)
		src.Close()
		w, _ := zw.Create(f.Name)
		w.Write(b)
	}
	zr.Close()

	w, err := zw.Create(name)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	if _, err := w.Write(body); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatalf("replace: %v", err)
	}
}

// stripCommas is the operation the recogniser proposes for this fixture's units
// column, applied the way a person accepting a proposal applies it.
func stripCommas(t *testing.T) func(*sheet.Sheet) {
	t.Helper()
	p, err := program.Parse(`replace(/,/, "")`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return func(sh *sheet.Sheet) {
		if err := sh.Apply(2, p); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	}
}

// A file declares the oldest build that could replay it. An operation nobody
// used must not lock every file this release touches out of every build before
// it, and one that was used must be refused by name rather than failing halfway
// through a replay.
func TestTheFormatVersionFollowsTheLog(t *testing.T) {
	for _, c := range []struct {
		name string
		edit func(*sheet.Sheet)
		want int
	}{
		{"an empty log", nil, baseVersion},
		{"single cells only", func(sh *sheet.Sheet) {
			if err := sh.Set(0, 2, "1204"); err != nil {
				t.Fatalf("Set: %v", err)
			}
		}, baseVersion},
		{"a column op", stripCommas(t), formatVersion},
	} {
		t.Run(c.name, func(t *testing.T) {
			path, _ := saved(t, "sales-q3.csv", c.edit)

			doc, err := Read(path)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if got := doc.Manifest.Format; got != c.want {
				t.Errorf("format = %d, want %d", got, c.want)
			}
		})
	}
}

// A column op has to survive the round trip and rebuild the same column, since
// one line of the log is the only record of what happened to thousands of cells.
func TestAColumnOpRoundTrips(t *testing.T) {
	path, _ := saved(t, "sales-q3.csv", stripCommas(t))

	doc, err := Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	for row, want := range map[int]string{0: "1204", 1: "987", 2: "1455"} {
		if got := doc.Sheet.At(row, 2); got != want {
			t.Errorf("cell (%d,2) = %q, want %q", row, got, want)
		}
	}
	if n := len(doc.Edits); n != 1 {
		t.Errorf("log = %d entries, want the one operation that did it", n)
	}
	if c := doc.Sheet.Columns[2]; c.Kind != sheet.KindNum || c.Flagged {
		t.Errorf("units = %v flagged=%v, want num and unflagged", c.Kind, c.Flagged)
	}
}
