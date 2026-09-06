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
| `ingest`   | bytes to rows: a CSV reader, a record scanner, a sniff   |
| `engine`   | open a file without loading it: index, pages, passes     |
| `pattern`  | the recogniser: watch edits, propose the rest            |
| `document` | the `.uno` codec, `Uint8Array` in and out                |
| `library`  | the `.unof` codec, string in and out                     |
| `store`    | the `FileStore` and `ByteSource` seams                   |

Everything above `store` is pure. This let's it share the same code across
platforms. This property should continue. `store/node` is the one file that
imports `node:fs`, and it is its own entry so a browser build never pulls it in.

## The engine

`engine` is what opens a file too large to hold. A worker runs `serve` with a
port and a way to open a `SourceRef`. It reads the header, then indexes the
file in 8 MB chunks, noting where every block of 1,024 rows starts. The client
holds an `Engine` and a `Band`: 2,000 rows around the viewport, answered
synchronously, with rows that have not arrived reported as pending.

Indexing is the first pass. Validation, deduplication, splitting and format
conversion are meant to be the next ones, each a loop over a `PassContext`
running in a worker of its own. `resource/composition.html` has the plan.

## Development

```bash
vp install   # dependencies
vp check     # format, lint, type check
vp test      # the ported Go suite
vp pack      # build dist/, with declarations
```
