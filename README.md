# uno

Easy spreadsheet handler

## Opening a .uno from the desktop

```
packaging/linux/associate.sh install
```

builds uno into `~/.local/bin` and registers `.uno` with the desktop, so
double-clicking one opens it. Windows has the same thing as
`packaging/windows/associate.ps1`. See [packaging/README.md](packaging/README.md)
for what each platform declares, and why macOS is not among them.
