/**
 * Test suite for the .mdf diagnostics analyzer.
 *
 * Runs with plain node -- no test framework, no vscode. Exits nonzero on
 * failure so `make check` can gate CI.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { analyze, atoi } = require('../extension/mdf-analyzer');

const TAG_DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'extension', 'data', 'fldigi-tags.json'), 'utf8')
);

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {string} text
 * @returns {string[]} the diagnostic codes produced, in order
 */
function codes(text) {
  return analyze(text, TAG_DATA).map((d) => d.code);
}

const HEADER = '//fldigi macro definition file extended\n';

/**
 * Wrap body lines in a minimal valid file.
 * @param {...string} body
 */
function doc(...body) {
  return HEADER + body.join('\n') + '\n';
}

console.log('atoi() mirrors C semantics');
test('parses leading digits', () => assert.strictEqual(atoi('42abc'), 42));
test('skips leading whitespace', () => assert.strictEqual(atoi('   7 x'), 7));
test('returns 0 for non-numeric', () => assert.strictEqual(atoi('abc'), 0));
test('handles negative', () => assert.strictEqual(atoi('-3'), -3));
test('empty string is 0', () => assert.strictEqual(atoi(''), 0));

console.log('\nreal-world files produce no findings');
for (const f of ['psk_macros.mdf', 'rtty_macros.mdf']) {
  const p = path.join(__dirname, 'fixtures', f);
  if (!fs.existsSync(p)) continue;
  test(`${f} is clean`, () => {
    const found = analyze(fs.readFileSync(p, 'utf8'), TAG_DATA);
    assert.deepStrictEqual(
      found.map((d) => `${d.code}@${d.line + 1}`),
      [],
      `unexpected findings: ${JSON.stringify(found.map((d) => d.code + '@' + (d.line + 1)))}`
    );
  });
}

console.log('\nheader rules');
test('E001 on missing header', () => assert.ok(codes('nope\n').includes('E001')));
test('E001 is case-sensitive', () =>
  assert.ok(codes('//FLDIGI MACRO DEFINITION FILE\n').includes('E001')));
test('no E001 without "extended" (it is optional)', () =>
  assert.ok(!codes('//fldigi macro definition file\n').includes('E001')));
test('W005 when "extended" absent', () =>
  assert.ok(codes('//fldigi macro definition file\n').includes('W005')));
test('no W005 when extended present', () => assert.ok(!codes(HEADER).includes('W005')));

console.log('\nmacro definition line');
test('E002 on index 48 (out of range)', () =>
  assert.ok(codes(doc('/$ 48 Label', '<TX>')).includes('E002')));
test('index 47 is valid', () =>
  assert.ok(!codes(doc('/$ 47 Label', '<TX>')).includes('E002')));
test('E003 when no space after number', () =>
  assert.ok(codes(doc('/$ 13', '<TX>')).includes('E003')));
test('trailing space is enough', () =>
  assert.ok(!codes(doc('/$ 13 ', '<TX>')).includes('E003')));
test('E004 on non-numeric index', () =>
  assert.ok(codes(doc('/$ abc Label', '<TX>')).includes('E004')));
test('W001 on duplicate index', () =>
  assert.ok(codes(doc('/$ 0 A', '<TX>', '/$ 0 B', '<RX>')).includes('W001')));
test('no W001 for distinct indices', () =>
  assert.ok(!codes(doc('/$ 0 A', '<TX>', '/$ 1 B', '<RX>')).includes('W001')));
test('E011 when convert shift overflows', () =>
  assert.ok(
    codes('//fldigi macro definition file\n/$ 46 X\n<TX>\n').includes('E011')
  ));
test('W007 on body text before any definition', () =>
  assert.ok(codes(doc('loose text', '/$ 0 X')).includes('W007')));

console.log('\ntag validation');
test('E009 on unknown tag', () =>
  assert.ok(codes(doc('/$ 0 X', '<QYS:typo>')).includes('E009')));
test('E009 on unknown inline tag', () =>
  assert.ok(codes(doc('/$ 0 X', '<!NOSUCH:1>')).includes('E009')));
test('E009 on unknown delayed tag', () =>
  assert.ok(codes(doc('/$ 0 X', '<@NOPE:1>')).includes('E009')));
test('known tags are accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<MYCALL><TX><RX><CLRTX>')), []));
test('tags are case-insensitive', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<wx><mycall><MyCall>')), []));
test('inline/delayed tags accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<!QSY:3579.2:800><@TXRSID:off>')), []));
test('<SAVE> and <MACROS:> are known', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<SAVE><MACROS:/tmp/a.mdf>')), []));
test('comment tags ignored', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<COMMENT:anything ><#short>')), []));
test('free text with angle brackets is not flagged', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', 'signal was 5 > 3 and a < b')), []));

console.log('\nEXEC blocks');
test('same-line EXEC is fine', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<EXEC>env | grep FLDIGI</EXEC>')), []));
test('multi-line EXEC is fine', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<EXEC>', 'ls -la', '</EXEC>')), []));
test('E007 on unclosed EXEC', () =>
  assert.ok(codes(doc('/$ 0 X', '<EXEC>ls -la')).includes('E007')));
test('E008 on lowercase close, same line', () =>
  assert.ok(codes(doc('/$ 0 X', '<EXEC>ls</exec>')).includes('E008')));
test('E008 on lowercase close, later line', () =>
  assert.ok(codes(doc('/$ 0 X', '<EXEC>', 'ls', '</exec>')).includes('E008')));
test('shell redirects inside EXEC are not flagged', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<EXEC>', 'a < b > c', '</EXEC>')), []));

console.log('\n<MACROS:> path rules');
test('E005 on tilde path', () =>
  assert.ok(codes(doc('/$ 0 X', '<MACROS:~/a.mdf>')).includes('E005')));
test('E005 on env var path', () =>
  assert.ok(codes(doc('/$ 0 X', '<MACROS:$HOME/a.mdf>')).includes('E005')));
test('E006 on relative path', () =>
  assert.ok(codes(doc('/$ 0 X', '<MACROS:other.mdf>')).includes('E006')));
test('absolute posix path is fine', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<MACROS:/Users/x/a.mdf>')), []));
test('absolute windows path is fine', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 X', '<MACROS:C:\\fldigi\\a.mdf>')), []));
test('W008 on empty path', () =>
  assert.ok(codes(doc('/$ 0 X', '<MACROS:>')).includes('W008')));

console.log('\nescape handling');
test('W002 on text after last \\n', () =>
  assert.ok(codes(doc('/$ 0 X', 'kept\\ndropped')).includes('W002')));
test('no W002 when \\n ends the line', () =>
  assert.ok(!codes(doc('/$ 0 X', 'all kept\\n')).includes('W002')));
test('W003 on multiple \\n markers', () =>
  assert.ok(codes(doc('/$ 0 X', 'a\\nb\\n')).includes('W003')));
test('single \\n is fine', () =>
  assert.ok(!codes(doc('/$ 0 X', 'a\\n')).includes('W003')));

console.log('\nFLTK label symbols');
test('valid symbols accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 CQ @>|', '<TX>')), []));
test('formatting prefix accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 CQ@#-2+', '<TX>')), []));
test('FLTK doc example accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 Big @+92->', '<TX>')), []));
test('@@ escape accepted', () =>
  assert.deepStrictEqual(codes(doc('/$ 0 Lit @@sign', '<TX>')), []));
test('E010 on unknown symbol', () =>
  assert.ok(codes(doc('/$ 0 Bad @nosuch', '<TX>')).includes('E010')));
test('all documented symbols accepted', () => {
  for (const s of TAG_DATA.fltkSymbols) {
    const found = codes(doc(`/$ 0 X @${s}`, '<TX>'));
    assert.deepStrictEqual(found, [], `symbol @${s} was flagged: ${found}`);
  }
});

console.log('\ncomment numbering convention');
test('W004 on mismatch', () =>
  assert.ok(codes(doc('// Macro # 5', '/$ 0 X', '<TX>')).includes('W004')));
test('no W004 when convention holds', () =>
  assert.ok(!codes(doc('// Macro # 1', '/$ 0 X', '<TX>')).includes('W004')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);