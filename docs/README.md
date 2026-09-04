# docs

[SYNTHESIS.md](SYNTHESIS.md) is the work list for extending the recogniser: what each
change touches, the test that pins it, and the command that proves it.

`preview.gif` is the fourteen-second preview at the top of the README: uno
opening `testdata/sales-q3.csv`, three flagged cells in `units` being fixed in
place — clicked, clicked again to open them, retyped where they sit — and then
the app recognising what those three edits have in common, rising from the
bottom of the window to offer the other 3,149, and doing them in one operation
that leaves the column badged `num`.

It is filmed, not drawn. The window is the real binary's, built with the `demo`
tag so it drives itself through the script in
[internal/ui/demo.go](../internal/ui/demo.go), while
[internal/uitest](../internal/uitest) films it with grim and encodes the frames
with ffmpeg.

The app drives itself because nothing else can. The preview has to click a cell,
click it again to open it, and type into it where it sits; Hyprland has
dispatchers for keys but none for a pointer button — so no compositor-level tool
can reach the grid. The script enters at `tapCell`, the one call a cell makes
when a pointer lands on it, so the selection, the editor, the `commit` and the
status refresh are the ones real clicks would produce rather than a mock-up of
them. The offer at the end is the same: nothing in the script puts the bar on
screen, because the third `commit` is what makes the recogniser find something
to ask about, and the last beat presses the button the bar itself would have.

## Re-shooting it

```
go test -tags screenshot -run TestPreviewGIF ./internal/uitest/
cp .screenshots/preview.gif docs/preview.gif
```

Needs a Hyprland session with `grim` and `ffmpeg`, like the rest of
`internal/uitest`. The take lands in `.screenshots/`, which is ignored; copying
one into `docs/` is deliberate, because which take ships is a judgement about
what looks right and not something a test should decide.

Leave the window unobstructed while it runs. The capture is of a screen region,
so anything overlapping the window is filmed with it — the test catches a blank
or wrong-sized grab, not a notification sitting on top of the grid.
