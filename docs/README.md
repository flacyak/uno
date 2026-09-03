# docs

`preview.gif` is the ten-second preview at the top of the README: uno opening
`testdata/sales-q3.csv`, and one flagged cell being fixed in place — clicked,
clicked again to open it, and retyped where it sits.

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
them.

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
