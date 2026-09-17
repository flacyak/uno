# uno

Easy spreadsheet handler

![uno opening a CSV, fixing three flagged cells, and applying its offer to fix the rest](docs/preview.gif)

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
vp run preview    # film docs/preview.gif
```

## Opening a .uno from the desktop

```
packaging/linux/associate.sh install
```

builds uno into `~/.local/bin` and registers `.uno` with the desktop, so
double-clicking one opens it. Windows has the same thing as
`packaging/windows/associate.ps1`. See [packaging/README.md](packaging/README.md)
for what each platform declares, and why macOS is not among them.
