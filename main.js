'use strict';

const obsidian = require('obsidian');
const { Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { Prec, StateEffect } = require('@codemirror/state');

function splitLinkText(raw) {
  let alias = null;
  let target = raw;
  const pipe = target.indexOf('|');
  if (pipe >= 0) {
    alias = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe);
  }
  const hash = target.indexOf('#');
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  const rest = hash === -1 ? '' : target.slice(hash + 1);
  const segments = rest
    .split('#')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const isBlockRef = segments.length > 0 && segments[segments.length - 1].startsWith('^');
  return { path, segments, alias, isBlockRef, subpath: segments.join('#') };
}

function normalizeHeading(text) {
  return String(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, p, a) => a || p)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC')
    .toLowerCase();
}

function parseHeadings(text) {
  const lines = text.split('\n');
  const headings = [];
  let fenceChar = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const char = fence[1][0];
      if (fenceChar === null) fenceChar = char;
      else if (fenceChar === char) fenceChar = null;
      continue;
    }
    if (fenceChar !== null) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) {
      headings.push({ index: headings.length, line: i, level: m[1].length, text: m[2], key: normalizeHeading(m[2]) });
    }
  }
  return { lines, headings };
}

function findSection(text, segments) {
  if (!segments || segments.length === 0) return null;
  const { lines, headings } = parseHeadings(text);
  let searchFrom = 0;
  let windowEnd = headings.length;
  let parentLevel = 0;
  let found = null;

  for (const segment of segments) {
    const key = normalizeHeading(segment);
    let hit = -1;
    for (let i = searchFrom; i < windowEnd; i++) {
      if (headings[i].level > parentLevel && headings[i].key === key) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return null;
    found = headings[hit];
    let nextEnd = windowEnd;
    for (let i = hit + 1; i < windowEnd; i++) {
      if (headings[i].level <= found.level) {
        nextEnd = i;
        break;
      }
    }
    searchFrom = hit + 1;
    windowEnd = nextEnd;
    parentLevel = found.level;
  }

  const bodyEnd = windowEnd < headings.length ? headings[windowEnd].line : lines.length;
  return {
    headingLine: found.line,
    headingText: found.text,
    level: found.level,
    bodyStart: found.line + 1,
    bodyEnd,
    body: lines.slice(found.line + 1, bodyEnd).join('\n'),
  };
}

function breadcrumbParts(path, segments) {
  const parts = [];
  if (path) parts.push(path.split('/').pop().replace(/\.md$/i, ''));
  for (const segment of segments) parts.push(segment.replace(/^\^/, ''));
  return parts;
}

function resolveLink(app, linktext, sourcePath) {
  const parsed = splitLinkText(linktext);
  if (!parsed.path) {
    return { parsed, file: app.vault.getAbstractFileByPath(sourcePath), reason: null };
  }
  const file = app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
  return { parsed, file, reason: file ? null : `no note matches "${parsed.path}"` };
}

function openLinkTarget(app, linktext, sourcePath, newLeaf) {
  const { file, reason } = resolveLink(app, linktext, sourcePath);
  if (!file) {
    new obsidian.Notice(`Heading Links: ${reason} (linked from ${sourcePath})`, 6000);
    return;
  }
  Promise.resolve(app.workspace.openLinkText(linktext, sourcePath, newLeaf)).catch((err) => {
    console.error('[heading-links] openLinkText failed', linktext, err);
    new obsidian.Notice(`Heading Links: could not open ${file.path}`, 6000);
  });
}

function wireLink(app, el, linktext, sourcePath, options) {
  const opts = options || {};

  el.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  el.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    openLinkTarget(app, linktext, sourcePath, 'tab');
  });

  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const mod = obsidian.Keymap ? obsidian.Keymap.isModEvent(event) : false;
    if (!mod && opts.onPlainClick) {
      opts.onPlainClick(event);
      return;
    }
    openLinkTarget(app, linktext, sourcePath, mod);
  });
  el.addEventListener('mouseover', (event) => {
    app.workspace.trigger('hover-link', {
      event,
      source: 'editor',
      hoverParent: { hoverPopover: null },
      targetEl: el,
      linktext,
      sourcePath,
    });
  });
}

function renderRefs(app, container, refs, sourcePath) {
  refs.forEach((ref, i) => {
    if (i > 0) container.createSpan({ cls: 'heading-links-refsep' }).setText(', ');
    const name = container.createSpan({ cls: 'heading-links-ref' });
    name.setAttribute('data-href', ref.sourcePath);
    name.setText(ref.sourceName + (ref.count > 1 ? ` (${ref.count})` : ''));
    wireLink(app, name, ref.sourcePath, sourcePath);
  });
}

function renderBreadcrumb(container, parts) {
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = container.createSpan({ cls: 'heading-links-sep' });
      sep.setText('>');
    }
    const chunk = container.createSpan({ cls: i === 0 ? 'heading-links-file' : 'heading-links-head' });
    chunk.setText(part);
  });
}

const refreshEffect = StateEffect.define();

function selectionTouches(state, from, to) {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function fileFromState(state) {
  const field = obsidian.editorInfoField;
  if (!field) return null;
  const info = state.field(field, false);
  return info && info.file ? info.file : null;
}

function toDecorationSet(ranges) {
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

function guarded(label, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[heading-links] ${label} failed, rendering nothing for this pass`, err);
    return Decoration.none;
  }
}

class BacklinkIndex {
  constructor(app) {
    this.app = app;
    this.byTarget = new Map();
    this.byFile = new Map();
  }

  rebuild() {
    const byTarget = new Map();
    const byFile = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const refs = (cache.links || []).concat(cache.embeds || []);
      for (const ref of refs) {
        const parsed = splitLinkText(ref.link || '');
        const target = parsed.path
          ? this.app.metadataCache.getFirstLinkpathDest(parsed.path, file.path)
          : file;
        if (!target) continue;
        if (target.path === file.path) continue;
        const entry = {
          sourcePath: file.path,
          sourceName: file.basename,
          segments: parsed.segments,
          line: (ref.position && ref.position.start && ref.position.start.line) || 0,
        };
        if (parsed.segments.length > 0 && !parsed.isBlockRef) {
          /* A heading link is already named under its heading, so the title
           * takes what no heading claims: plain links and block refs. */
          if (!byTarget.has(target.path)) byTarget.set(target.path, []);
          byTarget.get(target.path).push(entry);
          continue;
        }
        if (!byFile.has(target.path)) byFile.set(target.path, []);
        byFile.get(target.path).push(entry);
      }
    }
    this.byTarget = byTarget;
    this.byFile = new Map();
    for (const [path, refs] of byFile) this.byFile.set(path, dedupeBySource(refs));
  }

  refsFor(path) {
    return this.byTarget.get(path) || [];
  }

  fileRefsFor(path) {
    return this.byFile.get(path) || [];
  }
}

function dedupeBySource(refs) {
  const bucket = new Map();
  for (const ref of refs) {
    const existing = bucket.get(ref.sourcePath);
    if (existing) {
      existing.count += 1;
    } else {
      bucket.set(ref.sourcePath, {
        sourcePath: ref.sourcePath,
        sourceName: ref.sourceName,
        line: ref.line,
        count: 1,
      });
    }
  }
  return Array.from(bucket.values()).sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

/* The headings of this note that some other note points at, in document order.
 * A link into a heading that no longer exists resolves to nothing and drops out. */
function summarizeHeadings(text, refs) {
  const byLine = groupRefsByHeadingLine(text, refs);
  if (byLine.size === 0) return [];
  const titles = new Map();
  for (const heading of parseHeadings(text).headings) titles.set(heading.line, heading.text);
  return Array.from(byLine, ([line, refs]) => ({ line, text: titles.get(line) || '', refs })).sort(
    (a, b) => a.line - b.line
  );
}

function groupRefsByHeadingLine(text, refs) {
  const byLine = new Map();
  for (const ref of refs) {
    const section = findSection(text, ref.segments);
    if (!section) continue;
    if (!byLine.has(section.headingLine)) byLine.set(section.headingLine, []);
    byLine.get(section.headingLine).push(ref);
  }
  const out = new Map();
  for (const [line, bucket] of byLine) out.set(line, dedupeBySource(bucket));
  return out;
}

const INLINE_LINK = /(!?)\[\[([^\][\n]+)\]\]/g;

class BreadcrumbWidget extends WidgetType {
  constructor(plugin, linktext, parts, sourcePath) {
    super();
    this.plugin = plugin;
    this.linktext = linktext;
    this.parts = parts;
    this.sourcePath = sourcePath;
  }

  eq(other) {
    return other.linktext === this.linktext && other.sourcePath === this.sourcePath;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'heading-links-breadcrumb';
    el.setAttribute('data-href', this.linktext);
    renderBreadcrumb(el, this.parts);
    wireLink(this.plugin.app, el, this.linktext, this.sourcePath);
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

class BacklinkWidget extends WidgetType {
  constructor(plugin, refs, sourcePath) {
    super();
    this.plugin = plugin;
    this.refs = refs;
    this.sourcePath = sourcePath;
    this.key = refs.map((r) => `${r.sourcePath}:${r.count}`).join('|');
  }

  eq(other) {
    return other.key === this.key && other.sourcePath === this.sourcePath;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'heading-links-backlinks';
    renderRefs(this.plugin.app, el, this.refs, this.sourcePath);
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

function buildDecorations(view, plugin) {
  const ranges = [];
  const state = view.state;
  const doc = state.doc;
  const file = fileFromState(state);
  const sourcePath = file ? file.path : '';

  let refsByLine = null;
  if (plugin.settings.headingBacklinks && file) {
    const refs = plugin.index.refsFor(file.path);
    if (refs.length) refsByLine = groupRefsByHeadingLine(doc.toString(), refs);
  }

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);

      if (plugin.settings.breadcrumbLinks) {
        INLINE_LINK.lastIndex = 0;
        let match;
        while ((match = INLINE_LINK.exec(line.text)) !== null) {
          const start = line.from + match.index;
          const end = start + match[0].length;
          const parsed = splitLinkText(match[2]);
          if (parsed.alias !== null) continue;
          if (parsed.segments.length === 0) continue;
          if (match[1] === '!' && !plugin.settings.breadcrumbOnEmbeds) continue;
          if (selectionTouches(state, start, end)) continue;
          ranges.push(
            Decoration.replace({
              widget: new BreadcrumbWidget(plugin, match[2], breadcrumbParts(parsed.path, parsed.segments), sourcePath),
            }).range(start, end)
          );
        }
      }

      if (refsByLine && refsByLine.has(line.number - 1)) {
        ranges.push(
          Decoration.widget({
            widget: new BacklinkWidget(plugin, refsByLine.get(line.number - 1), sourcePath),
            side: 1,
          }).range(line.to)
        );
      }

      pos = line.to + 1;
    }
  }

  return toDecorationSet(ranges);
}

function makeViewPlugin(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = guarded('decorations', () => buildDecorations(view, plugin));
      }

      update(update) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshEffect))
        );
        if (update.docChanged || update.viewportChanged || update.selectionSet || refreshed) {
          this.decorations = guarded('decorations', () => buildDecorations(update.view, plugin));
        }
      }
    },
    { decorations: (value) => value.decorations }
  );
}

const TITLE_BADGE = 'heading-links-title-backlinks';

function viewText(view) {
  if (typeof view.getViewData === 'function') return view.getViewData();
  return typeof view.data === 'string' ? view.data : '';
}

function revealHeading(app, view, line) {
  const editor = view.editor;
  if (editor && typeof editor.setCursor === 'function') {
    editor.setCursor({ line, ch: 0 });
    if (typeof editor.scrollIntoView === 'function') {
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
    editor.focus();
    return;
  }
  const file = view.file;
  if (file) app.workspace.openLinkText(file.path, file.path, false);
}

/* The native menu class carries the background, border, shadow and position:
 * fixed. Only the coordinates are ours, kept inside the window. */
function placeMenu(menu, anchor) {
  const margin = 8;
  const at = anchor.getBoundingClientRect();
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const size = menu.getBoundingClientRect();
  const left = Math.max(margin, Math.min(at.left, window.innerWidth - size.width - margin));
  let top = at.bottom + 4;
  if (top + size.height > window.innerHeight - margin) {
    top = Math.max(margin, at.top - size.height - 4);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';
}

/* The inline title is not part of the document, it is a contenteditable div the
 * view keeps above the editor. The badge goes inside it so it sits at the end of
 * the title line and wraps with it, but the title text is what renames the file:
 * anything left in there while the user types would end up in the name. So the
 * badge is pulled out the moment the title takes focus and put back on blur. */
class TitleBacklinks {
  constructor(plugin) {
    this.plugin = plugin;
    this.menu = null;
    this.dismiss = null;
  }

  titleElFor(view) {
    if (!view || !view.containerEl) return null;
    for (const el of view.containerEl.querySelectorAll('.inline-title')) {
      if (!el.closest('.markdown-embed, .inline-embed, .hover-popover')) return el;
    }
    return null;
  }

  refresh() {
    this.closeSummary();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      try {
        this.render(leaf.view);
      } catch (err) {
        console.error('[heading-links] could not render title backlinks', err);
      }
    }
  }

  clearAll() {
    this.closeSummary();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const titleEl = this.titleElFor(leaf.view);
      if (titleEl) this.clear(titleEl);
    }
  }

  clear(titleEl) {
    titleEl.querySelectorAll('.' + TITLE_BADGE).forEach((el) => el.remove());
  }

  render(view) {
    const titleEl = this.titleElFor(view);
    if (!titleEl) return;
    this.clear(titleEl);
    const file = view.file;
    if (!file) return;
    if (titleEl === document.activeElement || titleEl.contains(document.activeElement)) return;

    const refs = this.plugin.settings.titleBacklinks ? this.plugin.index.fileRefsFor(file.path) : [];
    const groups = this.plugin.settings.headingSummary
      ? summarizeHeadings(viewText(view), this.plugin.index.refsFor(file.path))
      : [];
    if (refs.length === 0 && groups.length === 0) return;

    const badge = titleEl.createSpan({ cls: 'heading-links-backlinks ' + TITLE_BADGE });
    badge.contentEditable = 'false';
    badge.spellcheck = false;
    badge.addEventListener('mousedown', (event) => event.preventDefault());
    renderRefs(this.plugin.app, badge, refs, file.path);
    if (groups.length) this.renderChip(badge, view, groups, refs.length > 0);
  }

  renderChip(badge, view, groups, afterNames) {
    const chip = badge.createSpan({ cls: 'heading-links-chip' });
    const count = groups.length;
    chip.setText(`${afterNames ? '+' : ''}${count} heading${count > 1 ? 's' : ''}`);
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.menu) this.closeSummary();
      else this.openSummary(chip, view, groups);
    });
  }

  openSummary(chip, view, groups) {
    const app = this.plugin.app;
    const sourcePath = view.file.path;
    const menu = document.body.createDiv({ cls: 'menu heading-links-summary' });
    const grid = menu.createDiv({ cls: 'heading-links-summary-grid' });
    for (const group of groups) {
      const name = grid.createSpan({ cls: 'heading-links-summary-heading' });
      name.setText(group.text);
      name.addEventListener('click', () => {
        this.closeSummary();
        revealHeading(app, view, group.line);
      });
      renderRefs(app, grid.createSpan({ cls: 'heading-links-backlinks' }), group.refs, sourcePath);
    }
    /* Opening a note from inside the summary leaves it stale, so any click in
     * there closes it once the click has been handled. */
    menu.addEventListener('click', () => window.setTimeout(() => this.closeSummary(), 0), true);

    this.dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      /* A press on the chip is its own toggle, not a dismissal. */
      if (event.type === 'mousedown' && (menu.contains(event.target) || chip.contains(event.target))) return;
      this.closeSummary();
    };
    document.addEventListener('mousedown', this.dismiss, true);
    document.addEventListener('keydown', this.dismiss, true);
    window.addEventListener('resize', this.dismiss, true);

    this.menu = menu;
    placeMenu(menu, chip);
  }

  closeSummary() {
    if (!this.menu) return;
    document.removeEventListener('mousedown', this.dismiss, true);
    document.removeEventListener('keydown', this.dismiss, true);
    window.removeEventListener('resize', this.dismiss, true);
    this.menu.remove();
    this.menu = null;
    this.dismiss = null;
  }
}

const DEFAULT_SETTINGS = {
  breadcrumbLinks: true,
  breadcrumbOnEmbeds: false,
  headingBacklinks: true,
  titleBacklinks: true,
  headingSummary: true,
};

class HeadingLinksPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.index = new BacklinkIndex(this.app);
    this.titles = new TitleBacklinks(this);

    this.rebuildIndex = obsidian.debounce(
      () => {
        this.index.rebuild();
        this.refreshEditors();
      },
      300,
      true
    );

    this.registerEditorExtension(Prec.highest(makeViewPlugin(this)));
    this.addSettingTab(new HeadingLinksSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.index.rebuild();
      this.refreshEditors();
    });

    this.registerEvent(this.app.metadataCache.on('resolved', () => this.rebuildIndex()));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.rebuildIndex()));
    this.registerEvent(this.app.vault.on('rename', () => this.rebuildIndex()));
    this.registerEvent(this.app.vault.on('delete', () => this.rebuildIndex()));

    /* The view rewrites the title text on open and on rename, which drops the
     * badge with it, so it is rendered again after each of those. */
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshEditors()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshEditors()));
    for (const type of ['focusin', 'focusout']) {
      this.registerDomEvent(document, type, (event) => {
        const el = event.target;
        if (el instanceof HTMLElement && el.classList.contains('inline-title')) this.refreshEditors();
      });
    }
  }

  onunload() {
    if (this.titles) this.titles.clearAll();
  }

  refreshEditors() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      this.titles.refresh();
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view;
        const cm = view && view.editor && view.editor.cm;
        if (!cm) return;
        try {
          cm.dispatch({ effects: refreshEffect.of(null) });
        } catch (err) {
          console.error('[heading-links] could not refresh an editor', err);
        }
      });
    }, 0);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshEditors();
  }
}

class HeadingLinksSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new obsidian.Setting(containerEl)
      .setName('Breadcrumb links')
      .setDesc('Show [[Note#H1#H2]] as "Note > H1 > H2" while editing.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.breadcrumbLinks).onChange(async (value) => {
          this.plugin.settings.breadcrumbLinks = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Also on embeds')
      .setDesc('Apply the same to ![[Note#H1#H2]].')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.breadcrumbOnEmbeds).onChange(async (value) => {
          this.plugin.settings.breadcrumbOnEmbeds = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Heading backlinks')
      .setDesc('At the end of a heading line, name every other note linking to it.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.headingBacklinks).onChange(async (value) => {
          this.plugin.settings.headingBacklinks = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Title backlinks')
      .setDesc('At the end of the note title, name every other note linking to this note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.titleBacklinks).onChange(async (value) => {
          this.plugin.settings.titleBacklinks = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Heading summary')
      .setDesc('Next to the title, how many headings of this note are linked to. Click it for the list.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.headingSummary).onChange(async (value) => {
          this.plugin.settings.headingSummary = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = HeadingLinksPlugin;
module.exports.__test = {
  BacklinkIndex,
  splitLinkText,
  normalizeHeading,
  parseHeadings,
  findSection,
  breadcrumbParts,
  dedupeBySource,
  groupRefsByHeadingLine,
  summarizeHeadings,
  INLINE_LINK,
};
