# @uno/grid

uno's core, in TypeScript: sheets, formulas, the transform language and the
`.uno` container. It allows the Electron desktop and the web app can share
one codebase.

## What is in here

| module     | what it owns                                             |
| ---------- | -------------------------------------------------------- |
| `num`      | what a cell is worth                                     |
| `notation` | markdown in, symbols out                                 |
| `formula`  | parse, evaluate, the column dependency graph             |
| `program`  | the transform language a proposal names and a log stores |
| `sheet`    | one table, the edit log, binding and notation            |
| `ingest`   | bytes to a sheet: a CSV reader and a delimiter sniff     |
| `pattern`  | the recogniser: watch edits, propose the rest            |
| `document` | the `.uno` codec, `Uint8Array` in and out                |
| `library`  | the `.unof` codec, string in and out                     |
| `store`    | the `FileStore` seam, and its one Node implementation    |

Everything above `store` is pure. This let's it share the same code across
platforms. This property should continue

## Development

```bash
vp install   # dependencies
vp check     # format, lint, type check
vp test      # the ported Go suite
vp pack      # build dist/, with declarations
```
