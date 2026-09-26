# uno

Easy spreadsheet handler

![uno opening a workspace whose export was renamed, browsing its folder from the sources panel, peeking at files, pointing the workspace at the renamed export so its edits replay, adding a second export as a tab, then opening settings from the bottom left and trying the Tokyo Night, Catppuccin Frappé and Sakura themes in light and dark before returning to Paper Ember](docs/preview.gif)

Open a data file, fix what does not parse, and save it as a `.uno` that keeps
the original bytes alongside the log of every edit. Nothing leaves the machine.

## Developing

Every command runs from the repo root. `vp run` with no task lists them.

```bash
vp install        # install the workspace
vp run dev        # the desktop app, reloading
vp run build      # @uno/grid, then the desktop app
vp run check      # format, lint, type check
vp run test       # every package's suite
vp run smoke      # build, then drive the real desktop app and assert
vp run preview    # film docs/preview.gif: the browse story
                  # `vp run preview sidebar` films docs/sidebar.gif
```
