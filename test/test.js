/* Checks the parsing behind the plugin. Obsidian's API is stubbed, so this
 * runs with plain node and needs no vault. */

const fs = require('fs');
const path = require('path');
const Module = require('module');

class Fake {
  constructor() {}
  static fromClass() { return {}; }
  static of() { return {}; }
  static define() { return { of: () => ({}) }; }
  static replace() { return { range: () => ({}) }; }
  static widget() { return { range: () => ({}) }; }
  static set() { return {}; }
}
const fakeObsidian = {
  Plugin: Fake, PluginSettingTab: Fake, Setting: Fake, Notice: Fake,
  debounce: (fn) => fn, editorInfoField: null, Keymap: { isModEvent: () => false },
};
const fakeView = { Decoration: Fake, EditorView: Fake, ViewPlugin: Fake, WidgetType: Fake };
const fakeState = { Prec: Fake, StateEffect: Fake, StateField: Fake };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fakeObsidian;
  if (request === '@codemirror/view') return fakeView;
  if (request === '@codemirror/state') return fakeState;
  return origLoad.apply(this, arguments);
};

const PLUGIN = path.join(__dirname, '..', 'main.js');
const { __test: t } = require(PLUGIN);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

/* ---- reading a link ---- */
check('nested anchor', t.splitLinkText('Note#Ideas#Ana'),
  { path: 'Note', segments: ['Ideas', 'Ana'], alias: null, isBlockRef: false, subpath: 'Ideas#Ana' });
check('alias is kept apart', t.splitLinkText('Note#Ideas|shown').alias, 'shown');
check('no anchor means no segments', t.splitLinkText('Note').segments, []);
check('a link into the same note has no path', t.splitLinkText('#Ideas#Ana').path, '');
check('a block ref is recognised', t.splitLinkText('Note#^abc123').isBlockRef, true);

/* ---- what the breadcrumb shows ---- */
check('another note is named first', t.breadcrumbParts('dir/Note', ['Ideas', 'Ana']), ['Note', 'Ideas', 'Ana']);
check('a link into the current note shows only the headings', t.breadcrumbParts('', ['Utils']), ['Utils']);
check('nested, still only the headings', t.breadcrumbParts('', ['Ideas', 'Ana']), ['Ideas', 'Ana']);

/* ---- finding the heading a link points at ---- */
const note = [
  '# Top',
  '## Ideas',
  '#### Ana',
  'nested body line',
  '#### Bea',
  'other',
  '## Ana',
  'unrelated top level section',
  '## After',
].join('\n');

const nested = t.findSection(note, ['Ideas', 'Ana']);
check('a nested anchor finds the nested heading', nested.headingLine, 2);
check('the body stops at the next sibling', nested.body, 'nested body line');
check('the level is the nested one', nested.level, 4);
check('a flat anchor is ambiguous and takes the first', t.findSection(note, ['Ana']).headingLine, 2);
check('a parent section spans its children', t.findSection(note, ['Ideas']).bodyEnd, 6);
check('a missing heading resolves to nothing', t.findSection(note, ['Ideas', 'Nope']), null);
check('wrong nesting resolves to nothing', t.findSection(note, ['Bea', 'Ana']), null);

const fenced = ['## Real', '```', '## Not a heading, it is code', '```', 'tail', '## Next'].join('\n');
check('headings inside code fences are ignored', t.parseHeadings(fenced).headings.map((h) => h.text), ['Real', 'Next']);
check('a section keeps the fenced content', t.findSection(fenced, ['Real']).bodyEnd, 5);

/* ---- matching a heading by text ---- */
check('case and spacing do not matter', t.normalizeHeading('  Some   HEADING  '), 'some heading');
check('emphasis does not matter', t.normalizeHeading('**Bold** heading'), 'bold heading');
const decomposed = 'Ma\u0303e';
const composed = 'M\u00e3e';
check('the fixtures really differ in bytes', decomposed !== composed, true);
check('composed and decomposed text match', t.normalizeHeading(decomposed), t.normalizeHeading(composed));
check('a decomposed anchor still finds its heading',
  t.findSection(['## Ideas', '#### ' + composed, 'body'].join('\n'), ['Ideas', decomposed]).headingLine, 1);

/* ---- which notes get credited under which heading ---- */
const refs = [
  { sourcePath: 'Todo.md', sourceName: 'Todo', segments: ['Ideas', 'Ana'], line: 10 },
  { sourcePath: 'Todo.md', sourceName: 'Todo', segments: ['Ideas', 'Bea'], line: 11 },
  { sourcePath: 'Other.md', sourceName: 'Other', segments: ['Ideas', 'Ana'], line: 3 },
  { sourcePath: 'Other.md', sourceName: 'Other', segments: ['Ideas', 'Ana'], line: 9 },
];
const grouped = t.groupRefsByHeadingLine(note, refs);
check('a heading collects the notes pointing at it', grouped.get(2).map((r) => r.sourceName), ['Other', 'Todo']);
check('two links from one note collapse with a count', grouped.get(2)[0].count, 2);
check('a sibling heading is separate', grouped.get(4).map((r) => r.sourceName), ['Todo']);
check('the unrelated heading of the same name gets nothing', grouped.has(6), false);

/* ---- telling a link from an embed ---- */
t.INLINE_LINK.lastIndex = 0;
check('an embed is marked', t.INLINE_LINK.exec('![[A#B]]')[1], '!');
t.INLINE_LINK.lastIndex = 0;
check('a plain link is not', t.INLINE_LINK.exec('[[A#B]]')[1], '');

console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
