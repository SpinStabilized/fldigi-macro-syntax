/**
 * Diagnostics for fldigi macro definition (.mdf) files.
 *
 * This module deliberately has NO dependency on the vscode API so it can be
 * unit tested directly with node. `extension.js` adapts its output to
 * vscode.Diagnostic objects.
 *
 * Every rule here mirrors a specific behaviour in fldigi's
 * MACROTEXT::loadMacros() / expandMacro() (src/misc/macros.cxx). The point is
 * to surface failures that fldigi itself handles silently -- it will happily
 * load a broken file, drop macros, or overwrite your macro file with defaults
 * and never say a word.
 */

'use strict';

/**
 * @typedef {'error'|'warning'|'info'} Severity
 */

/**
 * @typedef {object} Finding
 * @property {number} line       Zero-based line number.
 * @property {number} startCol   Zero-based start column.
 * @property {number} endCol     Zero-based end column (exclusive).
 * @property {Severity} severity
 * @property {string} code       Stable rule id, e.g. 'E002'.
 * @property {string} message
 */

/**
 * @typedef {object} TagData
 * @property {string[]} immediate
 * @property {string[]} inline
 * @property {string[]} delayed
 * @property {string[]} datetime
 * @property {string[]} fltkSymbols
 * @property {string[]} modems
 * @property {number} [maxMacros]
 */

/** fldigi: MAXMACROS = MAXKEYROWS(4) * NUMMACKEYS(12) */
const DEFAULT_MAX_MACROS = 48;

/** The magic first line. Matched with plain find() => case-sensitive. */
const HEADER_PREFIX = '//fldigi macro definition file';

/**
 * Tags handled by dedicated grammar/parse rules rather than the tag tables.
 * '#' is the <#comment> shorthand; EXEC/'/EXEC' bracket a shell block.
 */
const STRUCTURAL_TAGS = new Set(['COMMENT', 'EXEC', '/EXEC']);

/**
 * Faithful reimplementation of C's atoi() for the subset fldigi relies on:
 * skip leading whitespace, optional sign, consume digits, stop at the first
 * non-digit, and return 0 when no digits are present at all.
 *
 * This matters because fldigi calls atoi(&mLine[3]) with no validation, so
 * "/$ abc label" silently yields macro number 0 and clobbers macro 0.
 *
 * @param {string} s
 * @returns {number}
 */
function atoi(s) {
  const m = /^[ \t\n\r\f\v]*([+-]?)(\d*)/.exec(s);
  if (!m || m[2] === '') return 0;
  const n = parseInt(m[2], 10);
  return m[1] === '-' ? -n : n;
}

/**
 * Build a case-insensitive lookup set. fldigi matches tag names with ufind(),
 * which uppercases both operands, so tag names are case-insensitive.
 *
 * @param {TagData} tagData
 * @returns {{immediate:Set<string>, inline:Set<string>, delayed:Set<string>}}
 */
function buildTagSets(tagData) {
  const up = (/** @type {string[]} */ xs) => new Set(xs.map((x) => x.toUpperCase()));
  return {
    immediate: up([...tagData.immediate, ...tagData.datetime]),
    inline: up(tagData.inline),
    delayed: up(tagData.delayed),
  };
}

/**
 * Longest-first FLTK symbol list, so '->|' is tested before '->'.
 * @param {string[]} symbols
 * @returns {string[]}
 */
function orderedSymbols(symbols) {
  return [...symbols].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Validate the symbol portion of a macro button label.
 *
 * fldigi passes the label straight to FLTK. FLTK reads '@' as introducing a
 * symbol, optionally preceded by formatting characters in a fixed order, and
 * '@@' as an escaped literal at-sign.
 *
 * @param {string} label       Label text (everything after "/$ n ").
 * @param {number} lineNo
 * @param {number} labelStart  Column where the label begins.
 * @param {string[]} symbols
 * @param {Finding[]} out
 */
function checkLabelSymbols(label, lineNo, labelStart, symbols, out) {
  const ordered = orderedSymbols(symbols);
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== '@') continue;
    if (label[i + 1] === '@') { i++; continue; } // '@@' escape

    const rest = label.slice(i + 1);
    // Formatting prefix, in the order FLTK mandates:
    //   '#' square scaling | +/-[1-9] size | '$' hflip / '%' vflip | rotation
    const fmt = /^(?:#)?(?:[+-][1-9])?(?:[$%])?(?:0\d{4}|\d)?/.exec(rest);
    const fmtLen = fmt ? fmt[0].length : 0;
    const after = rest.slice(fmtLen);

    const matched = ordered.find((s) => after.startsWith(s));
    if (matched) {
      i += fmtLen + matched.length;
      continue;
    }

    // Unrecognised: report through to the next whitespace.
    const wsRel = rest.search(/\s/);
    const tokenLen = 1 + (wsRel === -1 ? rest.length : wsRel);
    out.push({
      line: lineNo,
      startCol: labelStart + i,
      endCol: labelStart + i + tokenLen,
      severity: 'error',
      code: 'E010',
      message:
        `Unrecognized FLTK label symbol. FLTK draws '@' as a symbol; use '@@' ` +
        `for a literal at-sign, or one of: @> @>> @>| @|| @-> @<- @circle @square ...`,
    });
    i += tokenLen - 1;
  }
}

/**
 * Analyze a .mdf document.
 *
 * @param {string} text  Full document text.
 * @param {TagData} tagData  Contents of data/fldigi-tags.json.
 * @returns {Finding[]}
 */
function analyze(text, tagData) {
  /** @type {Finding[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  const maxMacros = tagData.maxMacros || DEFAULT_MAX_MACROS;
  const tagSets = buildTagSets(tagData);
  const symbols = tagData.fltkSymbols || [];

  // ---- header -----------------------------------------------------------
  // loadMacros() reads line 1 and bails with -2 unless it starts with the
  // magic string. Nothing loads at all -- this is a hard failure.
  const first = lines[0] !== undefined ? lines[0] : '';
  if (!first.startsWith(HEADER_PREFIX)) {
    out.push({
      line: 0,
      startCol: 0,
      endCol: Math.max(first.length, 1),
      severity: 'error',
      code: 'E001',
      message:
        `Missing or malformed header. The first line must begin with ` +
        `"${HEADER_PREFIX}" (case-sensitive) or fldigi loads no macros at all.`,
    });
  }

  // A header without "extended" puts the loader in convert mode, where every
  // macro number above 9 is silently shifted by +2.
  const convert = first.startsWith(HEADER_PREFIX) && !first.includes('extended');
  if (convert) {
    out.push({
      line: 0,
      startCol: 0,
      endCol: Math.max(first.length, 1),
      severity: 'warning',
      code: 'W005',
      message:
        `Header lacks "extended", so fldigi loads this file in legacy convert ` +
        `mode and shifts every macro number above 9 by +2.`,
    });
  }

  // ---- body -------------------------------------------------------------
  /** @type {Map<number, number>} first line each macro index was defined on */
  const seenIndex = new Map();
  /** @type {number|null} macro number from the most recent "// Macro # N" */
  let commentMacroNo = null;
  let commentMacroLine = -1;
  let sawAnyDefinition = false;

  let inExec = false;
  let execStartLine = -1;
  let execStartCol = -1;

  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];

    // --- EXEC block state ------------------------------------------------
    // <EXEC> opens via ufind() => case-insensitive.
    // </EXEC> is located with plain find() => MUST be uppercase.
    if (inExec) {
      const close = line.indexOf('</EXEC>');
      if (close !== -1) {
        inExec = false;
      } else {
        const wrongCase = /<\/exec>/i.exec(line);
        if (wrongCase && wrongCase[0] !== '</EXEC>') {
          out.push({
            line: n,
            startCol: wrongCase.index,
            endCol: wrongCase.index + wrongCase[0].length,
            severity: 'error',
            code: 'E008',
            message:
              `'</EXEC>' must be uppercase. fldigi locates the closing tag with a ` +
              `case-sensitive search, so '${wrongCase[0]}' will not close the block.`,
          });
        }
      }
      continue; // EXEC body is shell text; don't tag-check it
    }

    if (!line.length) continue;
    if (line.startsWith('//')) {
      const m = /^\/\/\s*Macro\s*#\s*(\d+)/i.exec(line);
      if (m) {
        commentMacroNo = parseInt(m[1], 10);
        commentMacroLine = n;
      }
      continue; // only '//' at column 0 is a comment
    }

    // --- macro definition line -------------------------------------------
    if (line.startsWith('/$')) {
      sawAnyDefinition = true;
      // fldigi: idx = mLine.find(" ", 3)
      const idx = line.indexOf(' ', 3);
      if (idx === -1) {
        out.push({
          line: n,
          startCol: 0,
          endCol: line.length,
          severity: 'error',
          code: 'E003',
          message:
            `Malformed macro definition: no space after the macro number. fldigi ` +
            `ignores this line entirely, and the following text is appended to the ` +
            `previous macro. Add a trailing space (e.g. "${line} ").`,
        });
        continue;
      }

      const numText = line.slice(3);
      const parsed = atoi(numText);
      if (!/^\s*[+-]?\d/.test(numText)) {
        out.push({
          line: n,
          startCol: 3,
          endCol: idx,
          severity: 'error',
          code: 'E004',
          message:
            `Macro number is not numeric. fldigi parses it with atoi(), which ` +
            `yields 0 here, silently overwriting macro 0.`,
        });
      }

      if (parsed < 0 || parsed > maxMacros - 1) {
        out.push({
          line: n,
          startCol: 3,
          endCol: idx,
          severity: 'error',
          code: 'E002',
          message:
            `Macro number ${parsed} is outside 0-${maxMacros - 1}. fldigi aborts the ` +
            `entire load here (break, not skip), so this macro AND every macro ` +
            `after it are silently discarded.`,
        });
      } else if (convert && parsed > maxMacros - 3) {
        // Range is checked before the +2 convert shift, so 46/47 become 48/49
        // and write past the end of name[]/text[].
        out.push({
          line: n,
          startCol: 3,
          endCol: idx,
          severity: 'error',
          code: 'E011',
          message:
            `Macro number ${parsed} in a non-"extended" file becomes ${parsed + 2} ` +
            `after fldigi's convert shift, which is past the end of its ${maxMacros}-entry ` +
            `array. Add "extended" to the header line.`,
        });
      } else {
        const prev = seenIndex.get(parsed);
        if (prev !== undefined) {
          out.push({
            line: n,
            startCol: 3,
            endCol: idx,
            severity: 'warning',
            code: 'W001',
            message:
              `Macro ${parsed} is already defined on line ${prev + 1}. fldigi replaces ` +
              `the label but CONCATENATES the body onto the earlier definition.`,
          });
        } else {
          seenIndex.set(parsed, n);
        }
      }

      // "// Macro # N" convention is N == index + 1. fldigi ignores the
      // comment entirely, but a mismatch means hand-editing has drifted.
      if (commentMacroNo !== null && commentMacroLine === n - 1) {
        if (commentMacroNo !== parsed + 1) {
          out.push({
            line: commentMacroLine,
            startCol: 0,
            endCol: lines[commentMacroLine].length,
            severity: 'info',
            code: 'W004',
            message:
              `Comment says "Macro # ${commentMacroNo}" but the definition below is ` +
              `macro ${parsed} (expected "Macro # ${parsed + 1}"). Cosmetic only -- ` +
              `fldigi ignores this comment.`,
          });
        }
        commentMacroNo = null;
      }

      checkLabelSymbols(line.slice(idx + 1), n, idx + 1, symbols, out);
      continue;
    }

    // --- macro body line -------------------------------------------------
    if (!sawAnyDefinition) {
      out.push({
        line: n,
        startCol: 0,
        endCol: line.length,
        severity: 'warning',
        code: 'W007',
        message:
          `Body text before any "/$" definition is appended to macro 0, because ` +
          `fldigi initialises its macro counter to 0.`,
      });
    }

    checkEscapes(line, n, out);
    checkTags(line, n, tagSets, out, (open, col) => {
      inExec = true;
      execStartLine = n;
      execStartCol = col;
    });
  }

  if (inExec) {
    out.push({
      line: execStartLine,
      startCol: execStartCol,
      endCol: execStartCol + 6,
      severity: 'error',
      code: 'E007',
      message: `'<EXEC>' is never closed. Add a matching uppercase '</EXEC>'.`,
    });
  }

  return out;
}

/**
 * fldigi: crlf = mLine.rfind("\\n") -- note rfind, the LAST occurrence.
 * Everything from there is erased and replaced with a real newline, so any
 * text after the last marker is silently dropped, and any EARLIER marker on
 * the same line survives as literal backslash-n in the transmitted text.
 *
 * @param {string} line
 * @param {number} lineNo
 * @param {Finding[]} out
 */
function checkEscapes(line, lineNo, out) {
  const last = line.lastIndexOf('\\n');
  if (last === -1) return;

  const trailing = line.slice(last + 2);
  if (trailing.length > 0) {
    out.push({
      line: lineNo,
      startCol: last + 2,
      endCol: line.length,
      severity: 'warning',
      code: 'W002',
      message:
        `Text after the last '\\n' on a line is silently discarded by fldigi ` +
        `(it truncates the line at that point).`,
    });
  }

  let count = 0;
  for (let i = line.indexOf('\\n'); i !== -1 && i < last; i = line.indexOf('\\n', i + 2)) count++;
  if (count > 0) {
    out.push({
      line: lineNo,
      startCol: line.indexOf('\\n'),
      endCol: last,
      severity: 'warning',
      code: 'W003',
      message:
        `Only the LAST '\\n' on a line becomes a newline. The ${count} earlier ` +
        `marker(s) are transmitted literally as backslash-n. Split across lines instead.`,
    });
  }
}

/**
 * Scan a body line for tags and validate them.
 *
 * @param {string} line
 * @param {number} lineNo
 * @param {{immediate:Set<string>, inline:Set<string>, delayed:Set<string>}} tagSets
 * @param {Finding[]} out
 * @param {(open:string, col:number)=>void} onExecOpen
 */
function checkTags(line, lineNo, tagSets, out, onExecOpen) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '<') continue;
    const close = line.indexOf('>', i);
    if (close === -1) break;

    const inner = line.slice(i + 1, close);
    const whole = line.slice(i, close + 1);

    if (inner.startsWith('#')) { i = close; continue; }      // <#comment>
    if (/^COMMENT:/i.test(inner)) { i = close; continue; }   // <COMMENT:...>

    if (/^EXEC$/i.test(inner)) {
      // The block may close later on this same line, which is how fldigi's
      // own default macros are written. Only enter multi-line EXEC state if
      // no uppercase terminator follows on this line.
      const sameLineClose = line.indexOf('</EXEC>', close + 1);
      if (sameLineClose !== -1) {
        i = sameLineClose + '</EXEC>'.length - 1;
        continue;
      }
      const wrongCase = /<\/exec>/i.exec(line.slice(close + 1));
      if (wrongCase) {
        const at = close + 1 + wrongCase.index;
        out.push({
          line: lineNo,
          startCol: at,
          endCol: at + wrongCase[0].length,
          severity: 'error',
          code: 'E008',
          message:
            `'</EXEC>' must be uppercase. fldigi locates the closing tag with a ` +
            `case-sensitive search, so '${wrongCase[0]}' will not close the block.`,
        });
        i = at + wrongCase[0].length - 1;
        continue;
      }
      onExecOpen(whole, i);
      return; // rest of the line is shell text
    }
    if (/^\/EXEC$/i.test(inner)) { i = close; continue; }

    // <MACROS:path> gets extra scrutiny: a path fldigi cannot open makes it
    // call create_new_macros(), which REPLACES your macros with defaults and
    // writes them to macros.mdf.
    const macrosMatch = /^MACROS:(.*)$/i.exec(inner);
    if (macrosMatch) {
      checkMacrosPath(macrosMatch[1], lineNo, i + 1 + 'MACROS:'.length, out);
      i = close;
      continue;
    }

    let name = inner;
    let sets = tagSets.immediate;
    if (name.startsWith('!')) { name = name.slice(1); sets = tagSets.inline; }
    else if (name.startsWith('@')) { name = name.slice(1); sets = tagSets.delayed; }

    const colon = name.indexOf(':');
    if (colon !== -1) name = name.slice(0, colon);
    if (!name) { i = close; continue; }

    // Only flag things that actually look like a tag; macro bodies are free
    // text and legitimately contain '<' and '>'.
    if (!/^[A-Za-z][A-Za-z0-9_/+]*$/.test(name)) { i = close; continue; }

    if (!sets.has(name.toUpperCase()) && !STRUCTURAL_TAGS.has(name.toUpperCase())) {
      const prefix = inner.startsWith('!') ? 'inline ' : inner.startsWith('@') ? 'delayed ' : '';
      out.push({
        line: lineNo,
        startCol: i,
        endCol: close + 1,
        severity: 'error',
        code: 'E009',
        message: `Unknown ${prefix}macro tag '<${inner}>'. fldigi transmits unrecognized tags as literal text.`,
      });
    }
    i = close;
  }
}

/**
 * @param {string} path
 * @param {number} lineNo
 * @param {number} startCol
 * @param {Finding[]} out
 */
function checkMacrosPath(path, lineNo, startCol, out) {
  const end = startCol + path.length;
  /** @type {(sev:Severity, code:string, msg:string)=>void} */
  const add = (sev, code, msg) => {
    out.push({ line: lineNo, startCol, endCol: end, severity: sev, code, message: msg });
  };

  if (!path) {
    add('warning', 'W008', `<MACROS:> has an empty path; fldigi ignores it.`);
    return;
  }
  if (path.startsWith('~')) {
    add(
      'error',
      'E005',
      `fldigi does not expand '~'. The path is passed straight to ifstream, the open ` +
        `fails, and fldigi then REPLACES your macros with defaults and overwrites ` +
        `macros.mdf. Use a full absolute path.`
    );
    return;
  }
  if (path.includes('$')) {
    add(
      'error',
      'E005',
      `fldigi does not expand environment variables here. The open fails, and fldigi ` +
        `then REPLACES your macros with defaults and overwrites macros.mdf. ` +
        `Use a full absolute path.`
    );
    return;
  }
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  if (!absolute) {
    add(
      'error',
      'E006',
      `Relative path resolves against fldigi's working directory, which is ` +
        `unpredictable for a GUI app. If the open fails, fldigi replaces your macros ` +
        `with defaults. Use a full absolute path.`
    );
  }
}

module.exports = { analyze, atoi, checkEscapes, checkTags, checkMacrosPath };