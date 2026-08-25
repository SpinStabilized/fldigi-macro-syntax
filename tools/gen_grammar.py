#!/usr/bin/env python3
"""
Generate the fldigi-mdf TextMate grammar directly from fldigi's own source.

The tag table in fldigi's src/misc/macros.cxx is the only authoritative list of
macro tags. Hand-maintaining a copy of it in the grammar guarantees drift: seven
tags were added between 4.1.23 and 4.2.13, and two more (<SAVE>, <MACROS:>) are
special-cased outside the table entirely and are easy to miss.

This script reads the source and emits:
  syntaxes/fldigi-mdf.tmLanguage.json   the grammar
  data/fldigi-tags.json                 tag + modem data for hover/completion

Usage:
    python3 gen_grammar.py --fldigi-src /path/to/fldigi [--out-dir .]
    python3 gen_grammar.py --macros path/to/macros.cxx [--globals path/to/globals.cxx]
    python3 gen_grammar.py ... --check      # verify existing files are up to date

Exit status is nonzero under --check if the generated output differs, so this
can gate CI.

Requires Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Final, Iterable, NamedTuple, Optional

# --------------------------------------------------------------------------
# Type aliases
#
# TextMate grammar nodes are deeply heterogeneous (a node may carry any of
# match / begin / end / name / captures / patterns / include), so a precise
# TypedDict would be more noise than signal. These aliases at least name the
# shapes being passed around.
# --------------------------------------------------------------------------

TMNode = dict[str, Any]           # one rule, or one capture entry
TMCaptures = dict[str, TMNode]    # capture-group index (as a string) -> rule
TMGrammar = dict[str, Any]        # the whole grammar document
TagData = dict[str, Any]          # the sidecar data document


class TagTable(NamedTuple):
    """Classified contents of fldigi's mtags[] table."""

    immediate: list[str]
    inline: list[str]
    delayed: list[str]
    raw_count: int


# --------------------------------------------------------------------------
# Constants
#
# Container choice is deliberate:
#   frozenset -> membership / set-difference only, order is meaningless
#   list      -> feeds a regex alternation or is emitted as JSON
# Every list below is passed through alternation() or symbol_alternation(),
# which sort longest-first, so the order written here is purely cosmetic.
# --------------------------------------------------------------------------

# Date/time tags take strftime-style format arguments and get their own rule so
# the % codes inside them can be highlighted separately.
DATETIME_TAGS: Final[list[str]] = ["ZDT", "ZT", "ZD", "ILDT", "IZDT", "LDT", "LT", "LD"]

# Handled by dedicated rules rather than the generic tag patterns. A frozenset
# because its only use is subtracting these out of the immediate-tag set.
SPECIAL_CASED: Final[frozenset[str]] = frozenset({"COMMENT", "EXEC", "/EXEC", "#"})

# Matched in expandMacro() before the mtags[] loop is reached, so they never
# appear in the table. Without these, <SAVE> and <MACROS:...> look like typos.
EXTRA_IMMEDIATE: Final[list[str]] = ["MACROS", "SAVE"]

# FLTK label symbols (fltk.org/doc-1.1/common.html#labels). Not derivable from
# fldigi source; fldigi just hands the label string to FLTK.
FLTK_SYMBOLS: Final[list[str]] = [
    "returnarrow", "UpArrow", "DnArrow", "circle", "square", "arrow",
    "line", "menu",
    "[]<<", "->|", "<->", "-->", ">[]",
    "->", "<-", ">>", "<<", ">|", "|>", "|<", "<|", "||",
    ">", "<", "+",
]

# FLTK formatting prefix, in the order FLTK requires:
#   '#' square scaling | +/-[1-9] size | '$' hflip / '%' vflip | rotation
# rotation is '0' plus four digits (degrees) or a single digit (45s).
FLTK_FORMAT_PREFIX: Final[str] = r"(?:#)?(?:[+-][1-9])?(?:[$%])?(?:0\d{4}|\d)?"

# strftime codes stay case-sensitive: %H (24-hour) and %h (abbrev. month) differ.
STRFTIME_CODES: Final[str] = r"%[aAbBcCdDeEFgGhHIjklmMnOpPrRsStTuUVwWxXyYzZ%]"

# Characters Oniguruma treats specially inside an alternation branch.
_REGEX_METACHARS: Final[frozenset[str]] = frozenset(r"[]|+*?.^$(){}\\")

MAX_MACROS: Final[int] = 48  # MAXKEYROWS(4) * NUMMACKEYS(12) in macros.h

# Tag names are matched with ufind(), which uppercases both sides, so tags are
# case-insensitive. These lookups use plain find() and stay case-sensitive:
#   - the "//fldigi macro definition file" header line
#   - the </EXEC> closing tag
# The grammar mirrors that split deliberately.


# --------------------------------------------------------------------------
# Source parsing
# --------------------------------------------------------------------------

def parse_mtags(macros_src: str) -> TagTable:
    """Extract and classify every entry in fldigi's mtags[] table."""
    entries: list[str] = re.findall(r'^\s*\{"(<[^"]*)"\s*,', macros_src, re.MULTILINE)
    if not entries:
        raise SystemExit("error: no mtags[] entries found - is this macros.cxx?")

    immediate: set[str] = set()
    inline: set[str] = set()
    delayed: set[str] = set()

    for raw in entries:
        body = raw[1:]                      # strip leading '<'
        bucket: set[str]
        if body.startswith("!"):
            bucket, body = inline, body[1:]
        elif body.startswith("@"):
            bucket, body = delayed, body[1:]
        else:
            bucket = immediate
        name = body.rstrip(":>")            # drop the ':' or '>' terminator
        if not name:
            continue
        bucket.add(name)

    immediate -= SPECIAL_CASED
    immediate -= set(DATETIME_TAGS)
    immediate.update(EXTRA_IMMEDIATE)

    return TagTable(
        immediate=sorted(immediate),
        inline=sorted(inline),
        delayed=sorted(delayed),
        raw_count=len(entries),
    )


def parse_modems(globals_src: str) -> list[str]:
    """Extract modem short names from the mode_info[] table for completion data.

    pMODEM() does an exact case-insensitive match against sname before falling
    back to its own regex, so names containing '/' or spaces (Cont-4/125,
    'DOMEX Micro') are valid even though that regex would reject them.
    """
    try:
        start = globals_src.index("mode_info[NUM_MODES] = {")
    except ValueError:
        return []
    end = globals_src.index("\n};", start)
    body = globals_src[start:end]
    names: list[str] = re.findall(r'\{\s*MODE_\w+\s*,\s*&\w+\s*,\s*"([^"]*)"', body)
    return [n for n in names if n]


def detect_version(src_root: Path) -> Optional[str]:
    """Read the fldigi version out of configure.ac, if present."""
    cfg = src_root / "configure.ac"
    if not cfg.is_file():
        return None
    txt = cfg.read_text(errors="replace")
    major = re.search(r"m4_define\(FLDIGI_MAJOR,\s*\[([^\]]*)\]", txt)
    minor = re.search(r"m4_define\(FLDIGI_MINOR,\s*\[([^\]]*)\]", txt)
    patch = re.search(r"m4_define\(FLDIGI_PATCH,\s*\[([^\]]*)\]", txt)
    if major and minor and patch:
        return f"{major.group(1)}.{minor.group(1)}{patch.group(1)}"
    return None


# --------------------------------------------------------------------------
# Regex assembly
# --------------------------------------------------------------------------

def _longest_first(names: Iterable[str]) -> list[str]:
    """Deduplicate and order so a longer name always precedes any prefix of it.

    Without this, '->' would match before '->|' and shred the longer symbol.
    Alphabetical tie-breaking keeps generated output byte-stable across runs.
    """
    return sorted(set(names), key=lambda s: (-len(s), s))


def alternation(names: Iterable[str]) -> str:
    """Build a fully-escaped regex alternation from tag names."""
    return "|".join(re.escape(n) for n in _longest_first(names))


def symbol_alternation(symbols: Iterable[str]) -> str:
    """Build an alternation from FLTK symbols.

    re.escape() would escape '-' and '>' too, which turns readable symbols like
    '->|' into visual noise in the emitted grammar, so only true Oniguruma
    metacharacters are escaped here.
    """
    branches: list[str] = []
    for sym in _longest_first(symbols):
        branches.append("".join("\\" + c if c in _REGEX_METACHARS else c for c in sym))
    return "|".join(branches)


# --------------------------------------------------------------------------
# Grammar construction
# --------------------------------------------------------------------------

def _scope(name: str) -> TMNode:
    """A capture entry that only assigns a scope name."""
    return {"name": name}


def _plain_tag_captures() -> TMCaptures:
    """Captures for <TAG> / <TAG:args>."""
    return {
        "1": _scope("punctuation.definition.tag.begin.mdf"),
        "2": _scope("entity.name.tag.immediate.mdf"),
        "3": _scope("punctuation.separator.key-value.mdf"),
        "4": _scope("variable.parameter.mdf"),
        "5": _scope("punctuation.definition.tag.end.mdf"),
    }


def _prefixed_tag_captures(kind: str, modifier_scope: str) -> TMCaptures:
    """Captures for <!TAG> / <@TAG>, which carry an extra modifier group."""
    return {
        "1": _scope("punctuation.definition.tag.begin.mdf"),
        "2": _scope(modifier_scope),
        "3": _scope(f"entity.name.tag.{kind}.mdf"),
        "4": _scope("punctuation.separator.key-value.mdf"),
        "5": _scope("variable.parameter.mdf"),
        "6": _scope("punctuation.definition.tag.end.mdf"),
    }


def _exec_tag_captures() -> TMCaptures:
    return {
        "1": _scope("punctuation.definition.tag.begin.mdf"),
        "2": _scope("entity.name.tag.mdf"),
        "3": _scope("punctuation.definition.tag.end.mdf"),
    }


def build_grammar(tags: TagTable) -> TMGrammar:
    """Assemble the complete TextMate grammar document."""
    all_alt: str = alternation(tags.immediate)
    inline_alt: str = alternation(tags.inline)
    delayed_alt: str = alternation(tags.delayed)
    datetime_alt: str = alternation(DATETIME_TAGS)
    symbol_alt: str = symbol_alternation(FLTK_SYMBOLS)

    repository: dict[str, TMNode] = {
        # Matched with plain find() in loadMacros(): case-sensitive, and the
        # 'extended' keyword is optional (older files are upgraded on load).
        "fileHeader": {
            "name": "markup.bold.header.mdf",
            "match": r"^//fldigi macro definition file( extended)?\s*$",
        },
        # Only a comment when '//' is the first two characters.
        "comments": {
            "name": "comment.line.double-slash.mdf",
            "match": r"^//.*$",
        },
        "macroDefinition": {
            "name": "meta.macro.header.mdf",
            "match": r"^(/\$)\s+(\d+)\s+(.*)$",
            "captures": {
                "1": _scope("keyword.control.macro.mdf"),
                "2": _scope("constant.numeric.macro-index.mdf"),
                "3": {
                    "name": "entity.name.function.macro-label.mdf",
                    "patterns": [{"include": "#labelSymbol"}],
                },
            },
        },
        "tags": {
            "patterns": [
                {"include": "#execBlock"},
                {"include": "#commentTag"},
                {"include": "#dateTimeTag"},
                {"include": "#tagInline"},
                {"include": "#tagDelayed"},
                {"include": "#tagImmediate"},
                {"include": "#unknownTag"},
            ]
        },
        "execBlock": {
            "name": "meta.tag.exec.mdf",
            # <EXEC> opens via ufind() -> case-insensitive.
            "begin": r"(<)((?i:EXEC))(>)",
            "beginCaptures": _exec_tag_captures(),
            # </EXEC> is found with plain find() -> MUST be uppercase. Left
            # case-sensitive on purpose so the editor breaks exactly where
            # fldigi breaks.
            "end": r"(</)(EXEC)(>)",
            "endCaptures": _exec_tag_captures(),
            # Deliberately opaque. Embedding source.shell lets bash's
            # redirection rule ('<' and '>' as operators) swallow the </EXEC>
            # terminator, which leaves the block open and breaks highlighting
            # for the rest of the file.
            "contentName": "string.unquoted.exec-body.mdf",
        },
        "commentTag": {
            "name": "comment.block.mdf",
            "match": r"<(?:(?i:COMMENT):|#)[^>]*>",
        },
        "dateTimeTag": {
            "match": rf"(<)((?i:{datetime_alt}))(?:(:)([^>]*))?(>)",
            "captures": {
                "1": _scope("punctuation.definition.tag.begin.mdf"),
                "2": _scope("entity.name.tag.immediate.mdf"),
                "3": _scope("punctuation.separator.key-value.mdf"),
                "4": {
                    "name": "variable.parameter.datetime-format.mdf",
                    "patterns": [{
                        "name": "constant.character.format.strftime.mdf",
                        "match": STRFTIME_CODES,
                    }],
                },
                "5": _scope("punctuation.definition.tag.end.mdf"),
            },
        },
        "tagInline": {
            "match": rf"(<)(!)((?i:{inline_alt}))(?:(:)([^>]*))?(>)",
            "captures": _prefixed_tag_captures(
                "inline", "keyword.other.inline-modifier.mdf"),
        },
        "tagDelayed": {
            "match": rf"(<)(@)((?i:{delayed_alt}))(?:(:)([^>]*))?(>)",
            "captures": _prefixed_tag_captures(
                "delayed", "keyword.other.delayed-modifier.mdf"),
        },
        "tagImmediate": {
            "match": rf"(<)((?i:{all_alt}))(?:(:)([^>]*))?(>)",
            "captures": _plain_tag_captures(),
        },
        "unknownTag": {
            "name": "invalid.illegal.unrecognized-tag.mdf",
            "match": r"<[!@]?[A-Za-z][A-Za-z0-9_/+]*(?::[^>]*)?>",
        },
        "escapes": {
            "patterns": [
                {
                    # Text after a '\n' marker on the same physical line is
                    # silently discarded by loadMacros().
                    "match": r"(\\n)([^\r\n]+)$",
                    "captures": {
                        "1": _scope("constant.character.escape.mdf"),
                        "2": _scope("invalid.illegal.unreachable-text.mdf"),
                    },
                },
                {
                    "name": "constant.character.escape.mdf",
                    "match": r"\\n",
                },
            ]
        },
        "labelSymbol": {
            "patterns": [
                {
                    "name": "constant.character.escape.at-sign.mdf",
                    "match": "@@",
                },
                {
                    "match": rf"(@)({FLTK_FORMAT_PREFIX})({symbol_alt})",
                    "captures": {
                        "1": _scope("punctuation.definition.symbol.mdf"),
                        "2": _scope("constant.other.symbol-format.mdf"),
                        "3": _scope("support.constant.symbol.mdf"),
                    },
                },
                {
                    "name": "invalid.illegal.unknown-symbol.mdf",
                    "match": r"@[^\s]*",
                },
            ]
        },
    }

    return {
        "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
        "name": "fldigi Macro",
        "scopeName": "source.mdf",
        "patterns": [
            {"include": "#fileHeader"},
            {"include": "#comments"},
            {"include": "#macroDefinition"},
            {"include": "#tags"},
            {"include": "#escapes"},
        ],
        "repository": repository,
    }


def build_tag_data(
    tags: TagTable,
    modems: list[str],
    version: Optional[str],
) -> TagData:
    """Sidecar data for future hover / completion / diagnostics providers."""
    return {
        "_generated_from": f"fldigi {version}" if version else "fldigi source",
        "_note": "Generated by gen_grammar.py. Do not edit by hand.",
        "caseInsensitiveTags": True,
        "execEndTagCaseSensitive": True,
        "maxMacros": MAX_MACROS,
        "immediate": tags.immediate,
        "inline": tags.inline,
        "delayed": tags.delayed,
        "datetime": DATETIME_TAGS,
        "fltkSymbols": FLTK_SYMBOLS,
        "modems": modems,
    }


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

def write_or_check(path: Path, content: str, check: bool) -> bool:
    """Write the file, or under --check report whether it is already correct."""
    if check:
        if not path.is_file():
            print(f"MISSING  {path}")
            return False
        if path.read_text() != content:
            print(f"STALE    {path}")
            return False
        print(f"ok       {path}")
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f"wrote    {path}")
    return True


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--fldigi-src", type=Path,
                    help="root of the fldigi source tree")
    ap.add_argument("--macros", type=Path,
                    help="path to src/misc/macros.cxx (overrides --fldigi-src)")
    ap.add_argument("--globals", type=Path,
                    help="path to src/globals/globals.cxx (for modem names)")
    ap.add_argument("--out-dir", type=Path, default=Path("."),
                    help="extension root (default: current directory)")
    ap.add_argument("--check", action="store_true",
                    help="verify generated files are up to date; nonzero exit if not")
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    ap = build_arg_parser()
    args = ap.parse_args(argv)

    macros_path: Optional[Path] = args.macros
    globals_path: Optional[Path] = args.globals
    version: Optional[str] = None

    if args.fldigi_src:
        macros_path = macros_path or args.fldigi_src / "src/misc/macros.cxx"
        globals_path = globals_path or args.fldigi_src / "src/globals/globals.cxx"
        version = detect_version(args.fldigi_src)

    if macros_path is None:
        ap.error("need --fldigi-src or --macros")
    if not macros_path.is_file():
        ap.error(f"not found: {macros_path}")

    tags: TagTable = parse_mtags(macros_path.read_text(errors="replace"))

    modems: list[str] = []
    if globals_path is not None and globals_path.is_file():
        modems = parse_modems(globals_path.read_text(errors="replace"))

    print(f"source   {macros_path}" + (f"  (fldigi {version})" if version else ""))
    print(f"tags     {tags.raw_count} table entries -> "
          f"{len(tags.immediate)} immediate (incl. {len(EXTRA_IMMEDIATE)} special-cased), "
          f"{len(tags.inline)} inline, {len(tags.delayed)} delayed, "
          f"{len(DATETIME_TAGS)} datetime")
    print(f"modems   {len(modems)}")

    grammar_txt: str = json.dumps(build_grammar(tags), indent=2) + "\n"
    data_txt: str = json.dumps(build_tag_data(tags, modems, version), indent=2) + "\n"

    ok = write_or_check(args.out_dir / "extension/syntaxes/fldigi-mdf.tmLanguage.json",
                        grammar_txt, args.check)
    ok &= write_or_check(args.out_dir / "extension/data/fldigi-tags.json",
                         data_txt, args.check)

    if args.check and not ok:
        print("\nGenerated files are out of date. Run without --check to regenerate.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())