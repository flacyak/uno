# docs

`preview.gif` is the ten-second preview at the top of the README: uno opening
`testdata/sales-q3.csv`, and one flagged cell being fixed.

It is filmed, not drawn. The window is the real binary's, built with the `demo`
tag so it drives itself through the script in
[internal/ui/demo.go](../internal/ui/demo.go), while
[internal/uitest](../internal/uitest) films it with grim and encodes the frames
with ffmpeg.

The app drives itself because nothing else can. The preview has to choose a cell
and type into it, choosing a cell means clicking one, and Hyprland has
dispatchers for keys but none for a pointer button — so no compositor-level tool
can reach the grid. The script goes through the same table selection, the same
`commit` and the same status refresh a click would, so what is on film is the
app rather than a mock-up of it.

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
