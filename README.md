# fldigi-macro-syntax

Syntax highlighting and diagnostics for fldigi macro definition (`.mdf`) files in VS Code.

## Features

- Highlighting for all macro tags (immediate, `<!inline>`, and `<@delayed>`).
- Tag names are matched case-insensitively, just like fldigi.
- FLTK button label symbols, including formatting prefixes and the `@@` escape.
- `<EXEC>` blocks, `<COMMENT:>` tags, and `\n` line markers.
- 18 diagnostics that catch failures fldigi handles silently.

The grammar is generated from fldigi's own source, so it never drifts from the program.

## Install

```sh
make deps    # one time, installs dev tooling
make sync    # copies extension/ into ~/.vscode/extensions/
```

Reload the VS Code window afterward. Grammar changes do not hot-reload.

## Diagnostics

Each rule maps to real behaviour in fldigi's `loadMacros()` or `expandMacro()`.

| Code | Severity | Problem                                                              |
|------|----------|----------------------------------------------------------------------|
| E001 | error    | Header missing or malformed, so nothing loads                        |
| E002 | error    | Macro number outside 0-47, aborts the whole load                     |
| E003 | error    | No space after the macro number, line is ignored                     |
| E004 | error    | Macro number is not numeric, overwrites macro 0                      |
| E005 | error    | `<MACROS:>` uses `~` or `$VAR`, which fldigi cannot expand           |
| E006 | error    | `<MACROS:>` path is relative, so it depends on the working directory |
| E007 | error    | `<EXEC>` is never closed                                             |
| E008 | error    | `</exec>` is lowercase, so it will not close the block               |
| E009 | error    | Unknown macro tag, sent as literal text                              |
| E010 | error    | Unrecognized FLTK label symbol                                       |
| E011 | error    | Legacy file, macro number shifts past the end of the array           |
| W001 | warning  | Duplicate macro number, bodies get concatenated                      |
| W002 | warning  | Text after the last `\n` on a line is discarded                      |
| W003 | warning  | Only the last `\n` on a line becomes a newline                       |
| W005 | warning  | Header lacks `extended`, numbers above 9 shift by +2                 |
| W007 | warning  | Body text before any `/$` is added to macro 0                        |
| W008 | warning  | `<MACROS:>` path is empty                                            |
| W004 | info     | `// Macro # N` comment disagrees with the `/$` number                |

A failed `<MACROS:>` load is destructive. fldigi replaces your macros with defaults, then saves them.

## Regenerating the grammar

The grammar and tag data come from fldigi's `macros.cxx` and `globals.cxx`.

```sh
make grammar FLDIGI_SRC=~/source/fldigi
```

Run this after upgrading fldigi. New releases add tags, and version 4.2.13 added seven.

## Repository layout

```
extension/     the extension itself (the only thing deployed)
  data/        generated tag tables
  syntaxes/    generated TextMate grammar
tools/         grammar generator
test/          test suite and sample .mdf files
```

Note there are two `package.json` files. The root one holds dev tooling, `extension/` holds the manifest.

## Development

```sh
make deps        # install dev tooling
make check       # grammar freshness, type checking, and tests
make dry-run     # preview what a sync would copy
make help        # list all targets
```

The analyzer in `extension/mdf-analyzer.js` has no VS Code dependency. It runs under plain node.

## License

MIT
