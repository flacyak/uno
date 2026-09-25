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
| `sheet`    | the edit log, folded into a schema and applied per row   |
| `ingest`   | bytes to rows: a CSV reader, a record scanner, a sniff   |
| `engine`   | open a file without loading it: index, pages, passes     |
| `pattern`  | the recogniser: watch edits, propose the rest            |
| `document` | the `.uno` codec, `Uint8Array` in and out                |
| `library`  | the `.unof` codecs, formulas and connections, as strings |
| `store`    | the `FileStore` and `ByteSource` seams                   |

Everything above `store` is pure. This lets it share the same code across
platforms. This property should continue. `store/node` and `store/disklister`
are the only files that import `node:fs`, and `store/node` is the only one that
runs a program, a profile's `credential_process`. `store/s3` and `store/sts`
are the only ones that reach a network. `tests/store/opens.test.ts` holds each
of them to that however a module is reached for, `import()` and `require()`
included, and plants a violation of every rule to prove it is caught.
`store/node` is its own entry, so a browser build never pulls it in.

## The engine

`engine` is what opens a file too large to hold. A worker runs `serve` with a
port and a way to open a `SourceRef`. It reads the header, then indexes the
file in 8 MB chunks, noting where every block of 1,024 rows starts. The client
holds an `Engine` and a `Band`: 2,000 rows around the viewport, answered
synchronously, with rows that have not arrived reported as pending.

The engine also owns the edit log. `sheet` folds the log into a `Schema`, and
`finish` applies it to a row when the row is read, so an edit is one line and a
new generation number rather than a rewrite. A `Sheet` is the same schema over
rows held in memory, which is how the tests in `tests/sheet` pin the rules a
file the engine never loads follows. The recogniser's `Survey` counts over one
block of rows at a time, so its offer can grow while the engine reads.

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
