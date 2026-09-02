# uno

Easy spreadsheet handler

![uno opening a CSV and fixing a flagged cell](docs/preview.gif)

Open a data file, fix what does not parse, and save it as a `.uno` that keeps
the original bytes alongside the log of every edit. Nothing leaves the machine.

## Opening a .uno from the desktop

```
packaging/linux/associate.sh install
```

builds uno into `~/.local/bin` and registers `.uno` with the desktop, so
double-clicking one opens it. Windows has the same thing as
`packaging/windows/associate.ps1`. See [packaging/README.md](packaging/README.md)
for what each platform declares, and why macOS is not among them.
