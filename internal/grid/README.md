# @uno/grid

uno's core, in TypeScript: sheets, formulas, the transform language and the
`.uno` container. It is a translation of the Go packages below `internal/ui`,
made so that the Electron desktop and the web app can share one codebase.

The reasoning behind the port — what moved, what did not, and the thirteen
places TypeScript had to be made to agree with Go — is in
`resource/ts-translate.html`.

## What is in here

| module     | what it owns                                               |
| ---------- | ---------------------------------------------------------- |
| `go`       | Go's semantics where JavaScript's differ. Read this first. |
| `num`      | what a cell is worth                                       |
| `notation` | markdown in, symbols out                                   |
| `formula`  | parse, evaluate, the column dependency graph               |
| `program`  | the transform language a proposal names and a log stores   |
| `sheet`    | one table, the edit log, binding and notation              |
| `ingest`   | bytes to a sheet: a CSV reader and a delimiter sniff       |
| `pattern`  | the recogniser: watch edits, propose the rest              |
| `document` | the `.uno` codec, `Uint8Array` in and out                  |
| `library`  | the `.unof` codec, string in and out                       |
| `store`    | the `FileStore` seam, and its one Node implementation      |

Everything above `store` is pure: no `node:fs`, no filesystem, no network. That
is what lets the same code serve the desktop and the browser, and it is the
property to protect when adding to this package.

## Development

```bash
vp install   # dependencies
vp check     # format, lint, type check
vp test      # the ported Go suite
vp pack      # build dist/, with declarations
```

The tests are the Go suite, carried across one for one — they are the
specification of the behaviour being translated, so a change that needs one of
them edited is a change to what uno does, not to how it is written.

Fixtures under `tests/testdata/` are **copies** of the repo's `testdata/`, not
symlinks.
