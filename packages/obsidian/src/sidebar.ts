import { type EpubBook, type SearchResult, type TocItem } from '@epub-pp/core';
import { Component, MarkdownRenderer, Platform, debounce, setIcon, type TFile } from 'obsidian';
import type { HighlightEntry } from './highlight-index';
import type { AnnotationProvider, EpubAnnotation } from './api';
import { layerId } from './constants';
import type { EpubView } from './view';

/** `toc`, `search`, `highlights`, or `provider:<id>` for another plugin's annotations. */
type Tab = string;

/** In-view sidebar (PDF++-style): table of contents, search, and highlights in this book. */
export class Sidebar {
	private tabs = new Map<Tab, { button: HTMLElement; panel: HTMLElement }>();
	private tocEl: HTMLElement;
	private tocItems = new Map<string, HTMLElement>();
	private currentToc: string | null = null;
	private searchInput!: HTMLInputElement;
	private searchInfo!: HTMLElement;
	private resultsEl!: HTMLElement;
	private results: SearchResult[] = [];
	private current = -1;
	private opts = { caseSensitive: false, wholeWord: false, regex: false };
	private highlightsEl: HTMLElement;
	private header: HTMLElement;
	private body: HTMLElement;
	private activeTab: Tab = 'toc';
	private providerPanels = new Map<string, ProviderPanel>();

	constructor(
		private view: EpubView,
		private el: HTMLElement,
	) {
		const header = (this.header = el.createDiv('epp-sidebar-tabs'));
		this.body = el.createDiv('epp-sidebar-body');
		this.tocEl = this.addTab('toc', 'list-tree', 'Contents');
		this.buildSearch(this.addTab('search', 'search', 'Search'));
		this.highlightsEl = this.addTab('highlights', 'highlighter', 'Highlights');
		if (Platform.isMobile) {
			const close = header.createDiv({ cls: 'clickable-icon epp-sidebar-close', attr: { 'aria-label': 'Close' } });
			setIcon(close, 'x');
			close.addEventListener('click', () => this.view.toggleSidebar(false));
		}
		this.showTab('toc');
	}

	private addTab(id: Tab, icon: string, label: string): HTMLElement {
		const button = createDiv({ cls: 'clickable-icon epp-sidebar-tab', attr: { 'aria-label': label } });
		// Provider tabs go after the built-in ones, before the mobile close button.
		this.header.insertBefore(button, this.header.querySelector('.epp-sidebar-close'));
		setIcon(button, icon);
		button.addEventListener('click', () => this.showTab(id));
		const panel = this.body.createDiv(`epp-panel epp-panel-${id.replace(/[^\w-]/g, '_')}`);
		this.tabs.set(id, { button, panel });
		return panel;
	}

	/** Add or update the tab of an annotation provider for the current book. */
	setProvider(provider: AnnotationProvider<unknown>, hidden: boolean): void {
		const id = layerId(provider.id);
		let panel = this.providerPanels.get(id);
		if (!panel) {
			panel = new ProviderPanel(this.view, provider, this.addTab(id, provider.icon ?? 'sparkles', provider.name), () => this.activeTab === id);
			this.providerPanels.set(id, panel);
		}
		panel.provider = provider;
		panel.update(hidden);
	}

	removeProvider(providerId: string): void {
		const id = layerId(providerId);
		const t = this.tabs.get(id);
		if (!t) return;
		t.button.remove();
		t.panel.remove();
		this.tabs.delete(id);
		this.providerPanels.delete(id);
		if (this.activeTab === id) this.showTab('toc');
	}

	showTab(id: Tab): void {
		if (!this.tabs.has(id)) id = 'toc';
		this.activeTab = id;
		for (const [k, t] of this.tabs) {
			t.button.toggleClass('is-active', k === id);
			t.panel.toggleClass('is-active', k === id);
		}
		const provider = this.providerPanels.get(id);
		this.view.setSearchNavVisible((id === 'search' && this.results.length > 0) || (!!provider && provider.count > 0));
		provider?.render();
		if (id !== 'search') this.view.reader?.showSearchResults([]);
		else {
			if (this.results.length) this.view.reader?.showSearchResults(this.results, -1);
			this.warmIndex();
		}
	}

	setBook(book: EpubBook | null): void {
		this.tocEl.empty();
		this.tocItems.clear();
		this.results = [];
		this.view.setSearchNavVisible(false);
		this.resultsEl?.empty();
		this.searchInfo?.setText('');
		// Providers re-add their tabs for the next book.
		for (const id of [...this.providerPanels.keys()]) this.removeProvider(id.replace(/^provider:/, ''));
		if (!book) return;
		if (!book.toc.length) this.tocEl.createDiv({ cls: 'epp-empty', text: 'This book has no table of contents.' });
		this.renderToc(book.toc, this.tocEl);
	}

	// --- TOC -------------------------------------------------------------------------------------

	private renderToc(items: TocItem[], parent: HTMLElement): void {
		for (const item of items) {
			const wrap = parent.createDiv('tree-item epp-toc-item');
			const self = wrap.createDiv('tree-item-self is-clickable epp-toc-self');
			self.style.paddingInlineStart = `${8 + item.depth * 14}px`;
			let childrenEl: HTMLElement | null = null;
			if (item.children.length) {
				const toggle = self.createDiv('tree-item-icon collapse-icon epp-toc-toggle');
				setIcon(toggle, 'right-triangle');
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					wrap.toggleClass('is-collapsed', !wrap.hasClass('is-collapsed'));
				});
				if (item.depth >= 1) wrap.addClass('is-collapsed');
			}
			self.createDiv({ cls: 'tree-item-inner', text: item.label || '(untitled)' });
			if (item.href) self.addEventListener('click', () => this.view.goToToc(item));
			else self.addClass('is-disabled');
			this.tocItems.set(item.id, self);
			if (item.children.length) {
				childrenEl = wrap.createDiv('tree-item-children');
				this.renderToc(item.children, childrenEl);
			}
		}
	}

	setCurrent(item: TocItem | null): void {
		if (this.currentToc === (item?.id ?? null)) return;
		if (this.currentToc) this.tocItems.get(this.currentToc)?.removeClass('is-active');
		this.currentToc = item?.id ?? null;
		const el = item && this.tocItems.get(item.id);
		if (!el) return;
		el.addClass('is-active');
		// expand ancestors
		for (let p = el.parentElement; p && p !== this.tocEl; p = p.parentElement) if (p.hasClass('is-collapsed')) p.removeClass('is-collapsed');
		el.scrollIntoView({ block: 'nearest' });
	}

	// --- Search ----------------------------------------------------------------------------------

	private buildSearch(panel: HTMLElement): void {
		const row = panel.createDiv('epp-search-row search-input-container');
		this.searchInput = row.createEl('input', { type: 'search', attr: { placeholder: 'Search book…', spellcheck: 'false' } });
		const toggles = panel.createDiv('epp-search-toggles');
		const toggle = (key: keyof typeof this.opts, label: string, title: string) => {
			const b = toggles.createDiv({ cls: 'epp-search-toggle', text: label, attr: { 'aria-label': title } });
			b.addEventListener('click', () => {
				this.opts[key] = !this.opts[key];
				b.toggleClass('is-active', this.opts[key]);
				this.runSearch();
			});
		};
		toggle('caseSensitive', 'Aa', 'Match case');
		toggle('wholeWord', 'ab', 'Whole word');
		toggle('regex', '.*', 'Regular expression');
		const nav = toggles.createDiv('epp-search-nav');
		this.searchInfo = nav.createDiv('epp-search-info');
		const prev = nav.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Previous (Shift+Enter)' } });
		setIcon(prev, 'chevron-up');
		prev.addEventListener('click', () => this.step(-1));
		const next = nav.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Next (Enter)' } });
		setIcon(next, 'chevron-down');
		next.addEventListener('click', () => this.step(1));
		this.resultsEl = panel.createDiv('epp-search-results');
		this.resultsEl.addEventListener(
			'scroll',
			() => {
				const el = this.resultsEl;
				if (this.renderedCount < this.results.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) this.renderMoreResults(100);
			},
			{ passive: true },
		);

		// Live search waits for 2+ characters (Enter searches anything); longer pause on mobile.
		const run = debounce(() => {
			const q = this.searchInput.value;
			if (q !== this.lastQuery && (q.trim().length >= 2 || !q.trim())) this.runSearch();
		}, Platform.isMobile ? 450 : 250, true);
		this.searchInput.addEventListener('input', run);
		this.searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				if (this.searchInput.value !== this.lastQuery) this.runSearch();
				this.step(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Escape') {
				this.searchInput.value = '';
				this.runSearch();
			}
		});
	}

	private lastQuery = '';

	/** Build the text index in the background so the first keystroke doesn't stall (slow phones). */
	private warmIndex(): void {
		const reader = this.view.reader;
		if (!reader) return;
		const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 50));
		idle(() => {
			if (this.view.reader === reader) void reader.textIndex.folded;
		});
	}

	focusSearch(query?: string): void {
		if (query) {
			this.searchInput.value = query;
			this.runSearch();
		}
		this.searchInput.focus();
		this.searchInput.select();
	}

	private runSearch(): void {
		const reader = this.view.reader;
		const q = this.searchInput.value;
		this.lastQuery = q;
		this.resultsEl.empty();
		this.current = -1;
		if (!reader || !q.trim()) {
			this.results = [];
			this.view.setSearchNavVisible(false);
			this.searchInfo.setText('');
			reader?.showSearchResults([]);
			return;
		}
		this.results = reader.search(q, { ...this.opts, limit: 2000 });
		this.searchInfo.setText(this.results.length >= 2000 ? '2000+ results' : `${this.results.length} result${this.results.length === 1 ? '' : 's'}`);
		reader.showSearchResults(this.results, -1);
		this.view.setSearchNavVisible(this.results.length > 0);

		this.renderedCount = 0;
		this.lastGroupSpine = -1;
		this.renderMoreResults(100);
	}

	private renderedCount = 0;
	private lastGroupSpine = -1;

	/** Results are appended in batches (on scroll) so huge result sets stay cheap to lay out. */
	private renderMoreResults(n: number): void {
		const end = Math.min(this.results.length, this.renderedCount + n);
		const frag = document.createDocumentFragment();
		for (let i = this.renderedCount; i < end; i++) {
			const r = this.results[i];
			if (r.spineIndex !== this.lastGroupSpine) {
				this.lastGroupSpine = r.spineIndex;
				frag.createDiv({ cls: 'epp-search-group', text: r.tocItem()?.label ?? `Section ${r.spineIndex + 1}` });
			}
			const el = frag.createDiv('epp-search-result');
			el.dataset.index = String(i);
			el.createSpan({ text: r.excerpt.before });
			el.createEl('mark', { cls: 'epp-search-match', text: r.excerpt.match });
			el.createSpan({ text: r.excerpt.after });
			el.addEventListener('click', () => this.select(i, true));
			if (i === this.current) el.addClass('is-active');
		}
		this.renderedCount = end;
		this.resultsEl.appendChild(frag);
	}

	step(delta: number): void {
		const provider = this.providerPanels.get(this.activeTab);
		if (provider) return provider.step(delta);
		if (!this.results.length) return;
		const n = this.results.length;
		this.select(this.current === -1 ? (delta > 0 ? 0 : n - 1) : (this.current + delta + n) % n);
	}

	/** `fromClick`: a result was tapped, so a drawer-style sidebar gets out of the way. */
	private select(i: number, fromClick = false): void {
		this.current = i;
		this.view.reader?.showSearchResults(this.results, i);
		this.searchInfo.setText(`${i + 1} / ${this.results.length}`);
		if (i >= this.renderedCount) this.renderMoreResults(i - this.renderedCount + 50);
		this.resultsEl.querySelector('.is-active')?.removeClass('is-active');
		const el = this.resultsEl.querySelector(`[data-index="${i}"]`) as HTMLElement | null;
		el?.addClass('is-active');
		el?.scrollIntoView({ block: 'nearest' });
		if (fromClick && this.view.sidebarIsOverlay()) this.view.toggleSidebar(false);
	}

	// --- Highlights ------------------------------------------------------------------------------

	private hlEntries: HighlightEntry[] = [];
	/** Collapsed group headings in the Highlights tab (`grouping:label`), kept while the view is open. */
	private collapsedGroups = new Set<string>();
	private hlRender: Component | null = null;

	setHighlights(entries: HighlightEntry[]): void {
		this.hlEntries = entries;
		this.renderHighlights();
	}

	/** Highlights tab: filter (all / annotation file / elsewhere), grouping, comments. */
	private renderHighlights(): void {
		const el = this.highlightsEl;
		const scroll = el.scrollTop;
		el.empty();
		const { plugin, reader, file } = this.view;
		const s = plugin.settings;
		const ann = file ? plugin.annotations.find(file) : null;
		const inAnn = (e: HighlightEntry) => !!ann && e.sourcePath === ann.path;

		const bar = el.createDiv('epp-hl-toolbar');
		const btn = bar.createEl('button', { cls: 'epp-hl-annotation-button' });
		setIcon(btn.createSpan(), 'notebook-pen');
		btn.createSpan({ text: ann ? 'Open annotation file' : 'Create annotation file' });
		btn.addEventListener('click', () => plugin.openAnnotationFile(this.view));

		const counts = { all: this.hlEntries.length, annotation: this.hlEntries.filter(inAnn).length, other: this.hlEntries.filter((e) => !inAnn(e)).length };
		const filters = el.createDiv('epp-segmented epp-hl-filters');
		const labels = { all: 'All', annotation: 'Annotation file', other: 'Elsewhere' } as const;
		for (const f of ['all', 'annotation', 'other'] as const) {
			const b = filters.createDiv({ cls: 'epp-mode-button', text: `${labels[f]} ${counts[f]}` });
			b.toggleClass('is-active', s.highlightsFilter === f);
			b.addEventListener('click', () => {
				s.highlightsFilter = f;
				plugin.saveSettings();
				this.renderHighlights();
			});
		}
		const groupRow = el.createDiv('epp-hl-group-row');
		groupRow.createSpan({ text: 'Group by' });
		const select = groupRow.createEl('select', { cls: 'dropdown' });
		for (const [v, t] of [
			['book', 'Book order'],
			['chapter', 'Chapter'],
			['note', 'Note'],
		] as const)
			select.createEl('option', { value: v, text: t });
		select.value = s.highlightsGroup;
		select.addEventListener('change', () => {
			s.highlightsGroup = select.value as typeof s.highlightsGroup;
			plugin.saveSettings();
			this.renderHighlights();
		});
		const toggleAll = groupRow.createDiv({ cls: 'clickable-icon epp-hl-collapse-all' });

		const shown = this.hlEntries.filter((e) => (s.highlightsFilter === 'all' ? true : s.highlightsFilter === 'annotation' ? inAnn(e) : !inAnn(e)));
		if (!shown.length) {
			const msg =
				s.highlightsFilter === 'annotation'
					? ann
						? 'No annotations in the annotation file yet.'
						: 'This book has no annotation file yet.'
					: 'No highlights yet. Select text, right-click and copy a link into a note.';
			el.createDiv({ cls: 'epp-empty', text: msg });
			return;
		}

		// Book order by resolved position (works for CFI and text-fragment links alike).
		const pos = new Map(shown.map((e) => [e, reader?.highlightRange(e.id) ?? null]));
		const sorted = [...shown].sort((a, b) => {
			const ra = pos.get(a);
			const rb = pos.get(b);
			if (!ra || !rb) return ra ? -1 : rb ? 1 : 0;
			return ra.compareBoundaryPoints(Range.START_TO_START, rb) || ra.compareBoundaryPoints(Range.END_TO_END, rb);
		});
		const groups = new Map<string, HighlightEntry[]>();
		const groupOf = (e: HighlightEntry): string => {
			if (s.highlightsGroup === 'note') return inAnn(e) ? `\u0000${ann!.basename}` : e.sourcePath.replace(/\.md$/, '');
			if (s.highlightsGroup === 'chapter') {
				const r = pos.get(e);
				return (r && reader?.tocItemAt(r)?.label) || 'Location not found';
			}
			return '';
		};
		for (const e of sorted) {
			const g = groupOf(e);
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g)!.push(e);
		}
		let order = [...groups.keys()];
		if (s.highlightsGroup === 'note') order = order.sort((x, y) => x.localeCompare(y)); // annotation file (\u0000) first

		// Collapse / expand all groups.
		const keyOf = (g: string) => `${s.highlightsGroup}:${g}`;
		const grouped = order.some((g) => g);
		toggleAll.toggle(grouped);
		const allCollapsed = grouped && order.every((g) => this.collapsedGroups.has(keyOf(g)));
		setIcon(toggleAll, allCollapsed ? 'chevrons-up-down' : 'chevrons-down-up');
		toggleAll.setAttr('aria-label', allCollapsed ? 'Expand all' : 'Collapse all');
		toggleAll.onclick = () => {
			const expand = order.every((g) => this.collapsedGroups.has(keyOf(g)));
			for (const g of order) {
				if (expand) this.collapsedGroups.delete(keyOf(g));
				else this.collapsedGroups.add(keyOf(g));
			}
			this.renderHighlights();
		};

		if (this.hlRender) this.view.removeChild(this.hlRender);
		this.hlRender = this.view.addChild(new Component());
		const palette = Object.fromEntries(s.palette.map((p) => [p.name, p.color]));
		for (const g of order) {
			const list = groups.get(g)!;
			let target = el;
			if (g) {
				const key = keyOf(g);
				const collapsed = this.collapsedGroups.has(key);
				const head = el.createDiv({ cls: 'epp-hl-group is-clickable' });
				head.toggleClass('is-collapsed', collapsed);
				setIcon(head.createSpan('epp-hl-group-chevron'), 'chevron-down');
				head.createSpan({ text: g.replace('\u0000', '') });
				head.createSpan({ cls: 'epp-hl-group-count', text: String(list.length) });
				target = el.createDiv('epp-hl-group-items');
				target.toggle(!collapsed);
				head.addEventListener('click', () => {
					const now = !this.collapsedGroups.has(key);
					if (now) this.collapsedGroups.add(key);
					else this.collapsedGroups.delete(key);
					head.toggleClass('is-collapsed', now);
					target.toggle(!now);
					const every = order.every((x) => this.collapsedGroups.has(keyOf(x)));
					setIcon(toggleAll, every ? 'chevrons-up-down' : 'chevrons-down-up');
				});
			}
			for (const e of list) this.renderHighlightItem(target, e, palette, inAnn(e) ? ann : null);
		}
		el.scrollTop = scroll;
	}

	private renderHighlightItem(el: HTMLElement, e: HighlightEntry, palette: Record<string, string>, ann: TFile | null): void {
		const s = this.view.plugin.settings;
		const item = el.createDiv('epp-hl-item');
		item.style.setProperty('--swatch', (e.color && (palette[e.color] ?? e.color)) || palette[s.defaultColor] || 'var(--text-highlight-bg)');
		const range = this.view.reader?.highlightRange(e.id);
		const text = range?.toString().replace(/\s+/g, ' ').trim();
		item.createDiv({ cls: 'epp-hl-text', text: text ? (text.length > 220 ? `${text.slice(0, 220)}…` : text) : '(location not found)' });
		if (e.comment) {
			const c = item.createDiv('epp-hl-comment markdown-rendered');
			void MarkdownRenderer.render(this.view.app, e.comment, c, e.sourcePath, this.hlRender!);
		}
		const meta = item.createDiv('epp-hl-meta');
		// In the annotation file the section heading says more than the file path.
		const label = ann ? (e.heading ?? ann.basename) : e.sourcePath.replace(/\.md$/, '');
		const note = meta.createEl('a', { cls: 'epp-hl-note' });
		if (ann) setIcon(note.createSpan('epp-hl-note-icon'), 'notebook-pen');
		note.createSpan({ text: label });
		note.setAttr('aria-label', e.sourcePath);
		note.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.view.plugin.openSource(e, this.view);
		});
		item.addEventListener('click', (ev) => {
			if ((ev.target as HTMLElement).closest('a')) return; // links inside comments
			this.view.navigate(e.locator);
			if (this.view.sidebarIsOverlay()) this.view.toggleSidebar(false);
		});
	}
}

/** A provider's tab: its annotations in book order, grouped by chapter, with a filter. */
class ProviderPanel {
	private items: { spec: { id: string; locator: string }; annotation: EpubAnnotation; text: string | null; chapter: string }[] = [];
	private shown: typeof this.items = [];
	private current = -1;
	private filter = '';
	private hidden = false;
	private stale = true;
	private rendered = 0;
	private listEl: HTMLElement | null = null;
	private infoEl: HTMLElement | null = null;
	private collapseAllEl: HTMLElement | null = null;
	/** Runs of shown items in the same chapter: `[start, end)` indexes into `shown`. */
	private groups: { chapter: string; start: number; end: number; items?: HTMLElement; filled?: number }[] = [];
	/** Chapters the user collapsed (kept across filtering and re-renders). */
	private collapsed = new Set<string>();

	constructor(
		private view: EpubView,
		public provider: AnnotationProvider<unknown>,
		private el: HTMLElement,
		private isActive: () => boolean,
	) {}

	get count(): number {
		return this.items.length;
	}

	/** The layer changed: re-read it now if the tab is showing, otherwise when it's opened. */
	update(hidden: boolean): void {
		this.hidden = hidden;
		this.stale = true;
		if (this.isActive()) this.render();
	}

	render(): void {
		const reader = this.view.reader;
		if (this.stale && reader) {
			this.stale = false;
			this.items = reader.describeLayer(layerId(this.provider.id)).map((d) => ({
				spec: d.spec,
				annotation: d.spec.data as EpubAnnotation,
				text: d.text,
				chapter: d.tocItem?.label ?? (d.text === null ? 'Location not found' : ''),
			}));
			this.current = -1;
		}
		const el = this.el;
		el.empty();
		const bar = el.createDiv('epp-provider-toolbar');
		bar.createDiv({ cls: 'epp-provider-name', text: this.provider.name });
		const eye = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': this.hidden ? 'Show in the book' : 'Hide in the book' } });
		setIcon(eye, this.hidden ? 'eye-off' : 'eye');
		eye.addEventListener('click', () => void this.view.plugin.setProviderHidden(this.provider.id, !this.hidden));
		this.collapseAllEl = bar.createDiv({ cls: 'clickable-icon' });
		this.collapseAllEl.addEventListener('click', () => {
			const chapters = this.groups.map((g) => g.chapter).filter(Boolean);
			const expand = chapters.every((c) => this.collapsed.has(c));
			for (const c of chapters) expand ? this.collapsed.delete(c) : this.collapsed.add(c);
			const scroll = this.listEl?.scrollTop ?? 0;
			this.renderList();
			if (this.listEl) this.listEl.scrollTop = expand ? scroll : 0;
		});

		const row = el.createDiv('epp-search-row search-input-container');
		const input = row.createEl('input', { type: 'search', attr: { placeholder: `Filter ${this.provider.name.toLowerCase()}…`, spellcheck: 'false' } });
		input.value = this.filter;
		const nav = el.createDiv('epp-search-toggles');
		this.infoEl = nav.createDiv('epp-search-info');
		const navEl = nav.createDiv('epp-search-nav');
		for (const [icon, label, delta] of [
			['chevron-up', 'Previous (Shift+Enter)', -1],
			['chevron-down', 'Next (Enter)', 1],
		] as const) {
			const b = navEl.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', () => this.step(delta));
		}
		this.listEl = el.createDiv('epp-search-results epp-provider-results');
		this.listEl.addEventListener(
			'scroll',
			() => {
				const l = this.listEl!;
				if (this.rendered < this.shown.length && l.scrollTop + l.clientHeight > l.scrollHeight - 400) this.renderMore(200);
			},
			{ passive: true },
		);
		input.addEventListener(
			'input',
			debounce(() => {
				this.filter = input.value;
				this.current = -1;
				this.renderList();
			}, 150, true),
		);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.step(e.shiftKey ? -1 : 1);
			}
		});
		this.renderList();
	}

	private renderList(): void {
		const q = this.filter.trim().toLowerCase();
		this.shown = q ? this.items.filter((i) => i.annotation.label.toLowerCase().includes(q) || (i.text ?? '').toLowerCase().includes(q) || i.chapter.toLowerCase().includes(q)) : this.items;
		this.groups = [];
		for (let i = 0; i < this.shown.length; i++) {
			const last = this.groups[this.groups.length - 1];
			if (last && last.chapter === this.shown[i].chapter) last.end = i + 1;
			else this.groups.push({ chapter: this.shown[i].chapter, start: i, end: i + 1 });
		}
		this.listEl!.empty();
		this.rendered = 0;
		this.updateInfo();
		this.updateCollapseAll();
		if (!this.items.length) this.listEl!.createDiv({ cls: 'epp-empty', text: `No ${this.provider.name.toLowerCase()} in this book.` });
		this.renderMore(200);
	}

	private updateInfo(): void {
		const n = this.shown.length;
		this.infoEl?.setText(this.current >= 0 ? `${this.current + 1} / ${n}` : `${n}${n === this.items.length ? '' : ` of ${this.items.length}`}`);
	}

	private updateCollapseAll(): void {
		const el = this.collapseAllEl;
		if (!el) return;
		const chapters = this.groups.map((g) => g.chapter).filter(Boolean);
		el.toggle(chapters.length > 0);
		const all = chapters.length > 0 && chapters.every((c) => this.collapsed.has(c));
		setIcon(el, all ? 'chevrons-up-down' : 'chevrons-down-up');
		el.setAttr('aria-label', all ? 'Expand all' : 'Collapse all');
	}

	private groupOf(i: number): (typeof this.groups)[number] | undefined {
		return this.groups.find((g) => i >= g.start && i < g.end);
	}

	/** Render items in book order, ~n at a time (books can have thousands); collapsed chapters are skipped. */
	private renderMore(n: number): void {
		let budget = n;
		let i = this.rendered;
		while (i < this.shown.length && budget > 0) {
			const group = this.groupOf(i)!;
			if (i === group.start) this.renderGroupHead(group);
			if (group.chapter && this.collapsed.has(group.chapter)) {
				i = group.end;
				continue;
			}
			const end = Math.min(group.end, i + budget);
			this.renderItems(group, i, end);
			budget -= end - i;
			i = end;
		}
		this.rendered = i;
	}

	private renderGroupHead(group: (typeof this.groups)[number]): void {
		const list = this.listEl!;
		if (!group.chapter) {
			group.items = list.createDiv();
			return;
		}
		const chapter = group.chapter;
		const head = list.createDiv('epp-search-group epp-provider-group');
		head.toggleClass('is-collapsed', this.collapsed.has(chapter));
		setIcon(head.createSpan('epp-hl-group-chevron'), 'chevron-down');
		head.createSpan({ cls: 'epp-provider-group-title', text: chapter });
		head.createSpan({ cls: 'epp-hl-group-count', text: String(group.end - group.start) });
		const items = (group.items = list.createDiv('epp-provider-group-items'));
		items.toggle(!this.collapsed.has(chapter));
		head.addEventListener('click', () => {
			const collapse = !this.collapsed.has(chapter);
			if (collapse) this.collapsed.add(chapter);
			else this.collapsed.delete(chapter);
			head.toggleClass('is-collapsed', collapse);
			items.toggle(!collapse);
			// Skipped while collapsed: render this chapter's items now.
			if (!collapse && (group.filled ?? group.start) < group.end) this.renderItems(group, group.filled ?? group.start, group.end);
			this.updateCollapseAll();
		});
	}

	private renderItems(group: (typeof this.groups)[number], start: number, end: number): void {
		const frag = document.createDocumentFragment();
		for (let i = start; i < end; i++) {
			const item = this.shown[i];
			const row = frag.createDiv('epp-search-result epp-provider-item');
			row.dataset.index = String(i);
			row.createDiv({ cls: 'epp-provider-label', text: item.annotation.label });
			const text = item.text ?? '(location not found)';
			// The annotated text, unless it only repeats the label
			if (text.toLowerCase() !== item.annotation.label.toLowerCase())
				row.createDiv({ cls: 'epp-provider-text', text: text.length > 160 ? `${text.slice(0, 160)}…` : text });
			row.addEventListener('click', () => this.select(i, true));
			if (i === this.current) row.addClass('is-active');
		}
		group.items!.appendChild(frag);
		group.filled = end;
	}

	step(delta: number): void {
		const n = this.shown.length;
		if (!n) return;
		this.select(this.current === -1 ? (delta > 0 ? 0 : n - 1) : (this.current + delta + n) % n);
	}

	private select(i: number, fromClick = false): void {
		this.current = i;
		this.updateInfo();
		if (i >= this.rendered) this.renderMore(i - this.rendered + 50);
		this.listEl?.querySelector('.is-active')?.removeClass('is-active');
		// Stepping into a collapsed chapter opens it.
		const group = this.groupOf(i);
		if (group?.chapter && this.collapsed.has(group.chapter)) (group.items?.previousElementSibling as HTMLElement | null)?.click();
		const row = this.listEl?.querySelector(`[data-index="${i}"]`) as HTMLElement | null;
		row?.addClass('is-active');
		row?.scrollIntoView({ block: 'nearest' });
		this.view.navigate(this.shown[i].spec.locator);
		if (fromClick && this.view.sidebarIsOverlay()) this.view.toggleSidebar(false);
	}
}
