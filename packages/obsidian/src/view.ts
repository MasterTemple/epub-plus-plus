import { EpubBook, EpubReader, parseLocator, type HighlightSpec, type SelectionInfo, type TocItem } from '@epub-pp/core';
import { FileView, Menu, Platform, Scope, TFile, setIcon, type MenuItem, type WorkspaceLeaf } from 'obsidian';
import type { HighlightEntry } from './highlight-index';
import type EpubPlusPlus from './main';
import { HOVER_SOURCE, VIEW_TYPE_EPUB } from './constants';
import { AppearancePanel } from './appearance';
import { Sidebar } from './sidebar';

export { VIEW_TYPE_EPUB };

export class EpubView extends FileView {
	book: EpubBook | null = null;
	reader: EpubReader | null = null;
	activeColor: string | null;
	private hostEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private chapterEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private paletteEl!: HTMLElement;
	private selectionBar!: HTMLElement;
	private sidebar!: Sidebar;
	private appearance!: AppearancePanel;
	private pendingSubpath: string | null = null;
	private loadToken = 0;
	private offIndex: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: EpubPlusPlus,
	) {
		super(leaf);
		this.activeColor = plugin.settings.defaultColor || null;
		this.scope = new Scope(this.app.scope);
		this.scope.register(['Mod'], 'f', () => {
			this.openSearch();
			return false;
		});
		// Build the UI immediately: Obsidian may call onLoadFile() before onOpen().
		this.buildUi();
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB;
	}

	override getDisplayText(): string {
		return this.file?.basename ?? 'EPUB';
	}

	override getIcon(): string {
		return 'book-open';
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === 'epub';
	}

	private buildUi(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('epp-view');
		root.toggleClass('epp-mobile', Platform.isMobile);
		root.toggleClass('epp-phone', Platform.isPhone);

		const toolbar = root.createDiv('epp-toolbar');
		this.toolbarButton(toolbar, 'list', 'Contents & search', () => this.toggleSidebar());
		const center = toolbar.createDiv('epp-toolbar-center');
		this.chapterEl = center.createDiv('epp-toolbar-title');
		this.progressEl = center.createDiv('epp-toolbar-progress');
		this.paletteEl = toolbar.createDiv('epp-palette');
		this.renderPalette();
		this.toolbarButton(toolbar, 'search', 'Search', () => this.openSearch());
		this.toolbarButton(toolbar, 'type', 'Appearance', () => this.toggleAppearance());

		this.mainEl = root.createDiv('epp-main');
		this.sidebar = new Sidebar(this, this.mainEl.createDiv('epp-sidebar'));
		this.mainEl.createDiv('epp-sidebar-backdrop').addEventListener('click', () => this.toggleSidebar(false));
		this.hostEl = this.mainEl.createDiv('epp-reader-host');
		this.appearance = new AppearancePanel(this.plugin, this.mainEl.createDiv('epp-appearance'));
		this.selectionBar = this.mainEl.createDiv('epp-selection-bar');
		this.toggleSidebar(!Platform.isMobile && this.plugin.settings.sidebarOpen, false);

		this.offIndex = (() => {
			const ref = this.plugin.index.on('changed', (paths) => {
				if (this.file && paths.has(this.file.path)) this.refreshHighlights();
			});
			return () => this.plugin.index.offref(ref);
		})();
		this.registerEvent(this.app.workspace.on('css-change', () => this.reader?.updateSettings({})));
	}

	override async onOpen(): Promise<void> {}

	override async onClose(): Promise<void> {
		this.offIndex?.();
		this.teardown();
	}

	private toolbarButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const b = parent.createDiv({ cls: 'clickable-icon epp-toolbar-button', attr: { 'aria-label': label } });
		setIcon(b, icon);
		b.addEventListener('click', onClick);
		return b;
	}

	// --------------------------------------------------------------------------------------------
	// Loading
	// --------------------------------------------------------------------------------------------

	override async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		this.teardown();
		this.chapterEl.setText('Loading…');
		try {
			const data = await this.app.vault.readBinary(file);
			if (token !== this.loadToken) return;
			const book = await EpubBook.open(data);
			if (token !== this.loadToken) return book.destroy();
			const s = this.plugin.settings;
			const reader = new EpubReader(this.hostEl, book, {
				settings: s.reader,
				palette: this.plugin.paletteRecord(),
				defaultColor: s.defaultColor,
				highlightOpacity: s.highlightOpacity,
			});
			this.book = book;
			this.reader = reader;
			await reader.render();
			if (token !== this.loadToken) return;
			this.bindReader(reader);
			if (this.sidebarIsOverlay()) this.toggleSidebar(false, false);
			this.chapterEl.setText(book.metadata.title);
			this.sidebar.setBook(book);
			this.refreshHighlights();
			const target = this.pendingSubpath ?? s.positions[file.path];
			this.pendingSubpath = null;
			if (target) this.navigate(target, !!target.match(/epubcfi|text=/) && target !== s.positions[file.path]);
		} catch (e) {
			console.error('[epub-pp] failed to open', file.path, e);
			this.chapterEl.setText('Failed to open EPUB');
			this.hostEl.createDiv({ cls: 'epp-error', text: `Could not open this EPUB: ${(e as Error).message}` });
		}
	}

	override async onUnloadFile(_file: TFile): Promise<void> {
		this.loadToken++;
		this.teardown();
	}

	override async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.refreshHighlights();
	}

	private teardown(): void {
		this.reader?.destroy();
		this.book?.destroy();
		this.reader = null;
		this.book = null;
		this.sidebar?.setBook(null);
		this.hostEl?.empty();
		this.selectionBar?.removeClass('is-visible');
	}

	// --------------------------------------------------------------------------------------------
	// Navigation / state
	// --------------------------------------------------------------------------------------------

	override setEphemeralState(state: unknown): void {
		const subpath = (state as { subpath?: string } | null)?.subpath;
		if (subpath) {
			if (this.reader?.isRendered) this.navigate(subpath);
			else this.pendingSubpath = subpath;
		}
		super.setEphemeralState(state);
	}

	/** Jump to a subpath (`#epubcfi(...)&color=..`, `#:~:text=..`, `#chapter.xhtml#id`). */
	navigate(subpath: string, flash = true): boolean {
		if (!this.reader) {
			this.pendingSubpath = subpath;
			return false;
		}
		const loc = parseLocator(subpath);
		const target = loc.cfi ?? loc.textFragment ?? loc.href;
		if (!target) return false;
		const ok = this.reader.goTo(target, { flash: flash && !!(loc.cfi || loc.textFragment) });
		if (!ok) console.warn('[epub-pp] could not resolve', subpath);
		return ok;
	}

	goToToc(item: TocItem): void {
		this.reader?.goTo(item);
		if (this.sidebarIsOverlay()) this.toggleSidebar(false);
	}

	/** True when the sidebar floats over the text (mobile, or a narrow pane). */
	sidebarIsOverlay(): boolean {
		const sb = this.mainEl.querySelector('.epp-sidebar');
		return !!sb && getComputedStyle(sb).position === 'absolute';
	}

	private bindReader(reader: EpubReader): void {
		reader.on('relocated', (loc) => {
			if (!this.file) return;
			this.plugin.savePosition(this.file.path, loc.cfi);
			this.progressEl.setText(`${Math.round(loc.progress * 100)}%`);
			this.chapterEl.setText(loc.tocItem?.label ?? this.book?.metadata.title ?? '');
			this.sidebar.setCurrent(loc.tocItem);
		});
		reader.on('external-link', (_e, url) => window.open(url, '_blank'));
		reader.on('highlight-click', (e, specs) => {
			const entries = specs.map((s) => s.data as HighlightEntry);
			if (Platform.isMobile || entries.length > 1) {
				const menu = new Menu();
				this.addHighlightItems(menu, entries);
				menu.showAtMouseEvent(e);
			} else this.plugin.openSource(entries[0], this);
		});
		reader.on('highlight-hover', (e, specs) => {
			const entry = specs[0].data as HighlightEntry;
			this.app.workspace.trigger('hover-link', {
				event: e,
				source: HOVER_SOURCE,
				hoverParent: this,
				targetEl: this.hostEl,
				linktext: entry.sourcePath,
				sourcePath: this.file?.path ?? '',
				state: { scroll: entry.position.start.line },
			});
		});
		reader.on('contextmenu', (e, { selection, highlights }) => {
			const info = selection ?? this.paragraphAt(e);
			if (!info && !highlights.length) return;
			e.preventDefault();
			const menu = new Menu();
			if (info) this.addSelectionItems(menu, info, !selection);
			if (highlights.length) this.addHighlightItems(menu, highlights.map((h) => h.data as HighlightEntry));
			menu.showAtMouseEvent(e);
		});
		reader.on('selectionchange', (sel) => this.updateSelectionBar(sel));
	}

	/** Paragraph under the pointer, so right-click works without an explicit selection. */
	private paragraphAt(e: MouseEvent): SelectionInfo | null {
		const el = (e.composedPath()[0] as Element | undefined) ?? null;
		const block = el?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, pre');
		if (!block || !this.reader?.content.contains(block)) return null;
		const range = document.createRange();
		range.selectNodeContents(block);
		return this.reader.describeRange(range);
	}

	// --------------------------------------------------------------------------------------------
	// Highlights
	// --------------------------------------------------------------------------------------------

	refreshHighlights(): void {
		if (!this.reader || !this.file) return;
		const entries = this.plugin.index.get(this.file.path);
		const specs: HighlightSpec<HighlightEntry>[] = entries.map((e) => ({ id: e.id, locator: e.locator, color: e.color, data: e }));
		this.reader.setHighlights(specs);
		this.sidebar.setHighlights(entries);
	}

	applyPalette(): void {
		this.renderPalette();
		this.reader?.setPalette(this.plugin.paletteRecord(), this.plugin.settings.defaultColor);
	}

	private renderPalette(): void {
		const el = this.paletteEl;
		el.empty();
		const add = (name: string | null, color: string, label: string) => {
			const sw = el.createDiv({ cls: 'epp-swatch', attr: { 'aria-label': label } });
			sw.style.setProperty('--swatch', color);
			if (!name) sw.addClass('epp-swatch-none');
			sw.toggleClass('is-active', this.activeColor === name);
			sw.addEventListener('click', () => {
				this.activeColor = name;
				this.renderPalette();
				const sel = this.reader?.getSelection();
				// PDF++-like: clicking a color while text is selected copies a link in that color.
				if (sel) this.plugin.copy(this, sel, 'link', name);
			});
		};
		for (const p of this.plugin.settings.palette) add(p.name, p.color, p.name);
		add(null, 'transparent', 'No color');
	}

	// --------------------------------------------------------------------------------------------
	// Menus
	// --------------------------------------------------------------------------------------------

	private colorTitle(name: string | null): DocumentFragment {
		const frag = document.createDocumentFragment();
		const sw = frag.createSpan({ cls: 'epp-menu-swatch' });
		const color = name ? this.plugin.settings.palette.find((p) => p.name === name)?.color ?? name : 'transparent';
		sw.style.setProperty('--swatch', color);
		if (!name) sw.addClass('epp-swatch-none');
		frag.appendText(name ?? 'No color');
		return frag;
	}

	/** Add an item that runs `action(color)`; with submenu support it offers every palette color. */
	private addColorItem(menu: Menu, title: string, icon: string, section: string, action: (color: string | null) => void): void {
		menu.addItem((item) => {
			item.setTitle(title).setIcon(icon).setSection(section);
			const sub: Menu | undefined = (item as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.();
			if (sub) {
				const colors: (string | null)[] = [...this.plugin.settings.palette.map((p) => p.name), null];
				for (const c of colors) sub.addItem((si) => si.setTitle(this.colorTitle(c)).setChecked(c === this.activeColor).onClick(() => action(c)));
			} else item.onClick(() => action(this.activeColor));
		});
	}

	addSelectionItems(menu: Menu, info: SelectionInfo, isParagraph = false): void {
		const s = this.plugin.settings;
		const section = 'epp-selection';
		if (isParagraph) menu.addItem((i) => (i.setTitle('Paragraph') as any).setIsLabel?.(true).setSection?.(section));
		this.addColorItem(menu, 'Copy link', 'link', section, (c) => this.plugin.copy(this, info, 'link', c));
		for (const fmt of s.copyFormats) {
			this.addColorItem(menu, `Copy as ${fmt.name.toLowerCase()}`, fmt.name.toLowerCase().includes('callout') ? 'quote' : 'clipboard-copy', section, (c) =>
				this.plugin.copy(this, info, fmt, c),
			);
		}
		menu.addItem((i) =>
			i
				.setTitle(s.linkType === 'cfi' ? 'Copy text-fragment link' : 'Copy CFI link')
				.setIcon('link-2')
				.setSection(section)
				.onClick(() => this.plugin.copy(this, info, 'alt-link', this.activeColor)),
		);
		menu.addItem((i) => i.setTitle('Copy text').setIcon('copy').setSection(section).onClick(() => this.plugin.copy(this, info, 'text', null)));
	}

	addHighlightItems(menu: Menu, entries: HighlightEntry[]): void {
		for (const entry of entries) {
			const section = `epp-hl-${entry.id}`;
			const note = entry.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? entry.sourcePath;
			if (entries.length > 1) menu.addItem((i) => (i.setTitle(`Highlight in "${note}"`) as any).setIsLabel?.(true).setSection?.(section));
			menu.addItem((i) => i.setTitle(`Open in "${note}"`).setIcon('file-text').setSection(section).onClick(() => this.plugin.openSource(entry, this)));
			menu.addItem((item) => {
				item.setTitle('Change color').setIcon('palette').setSection(section);
				const sub: Menu | undefined = (item as MenuItem & { setSubmenu?: () => Menu }).setSubmenu?.();
				const colors: (string | null)[] = [...this.plugin.settings.palette.map((p) => p.name), null];
				if (sub) {
					for (const c of colors)
						sub.addItem((si) => si.setTitle(this.colorTitle(c)).setChecked((entry.color ?? null) === c).onClick(() => this.plugin.setHighlightColor(entry, c)));
				} else item.onClick(() => this.showColorMenu(entry));
			});
			menu.addItem((i) =>
				i
					.setTitle('Copy link')
					.setIcon('link')
					.setSection(section)
					.onClick(async () => {
						await navigator.clipboard.writeText(entry.original);
					}),
			);
		}
	}

	private showColorMenu(entry: HighlightEntry): void {
		const m = new Menu();
		for (const c of [...this.plugin.settings.palette.map((p) => p.name), null])
			m.addItem((i) => i.setTitle(this.colorTitle(c)).onClick(() => this.plugin.setHighlightColor(entry, c)));
		const r = this.hostEl.getBoundingClientRect();
		m.showAtPosition({ x: r.left + r.width / 2, y: r.top + 80 });
	}

	// --------------------------------------------------------------------------------------------
	// Selection bar (mobile: there is no right-click)
	// --------------------------------------------------------------------------------------------

	private updateSelectionBar(sel: SelectionInfo | null): void {
		const bar = this.selectionBar;
		if (!Platform.isMobile || !this.plugin.settings.selectionBar || !sel) {
			bar.removeClass('is-visible');
			return;
		}
		bar.empty();
		const btn = (icon: string, label: string, fn: () => void) => {
			const b = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.createSpan({ text: label });
			b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
			b.addEventListener('click', fn);
		};
		btn('link', 'Link', () => this.plugin.copy(this, sel, 'link', this.activeColor));
		const callout = this.plugin.settings.copyFormats[0];
		if (callout) btn('quote', callout.name, () => this.plugin.copy(this, sel, callout, this.activeColor));
		btn('more-horizontal', 'More', () => {
			const menu = new Menu();
			this.addSelectionItems(menu, sel);
			const r = bar.getBoundingClientRect();
			menu.showAtPosition({ x: r.left, y: r.top });
		});
		bar.addClass('is-visible');
	}

	// --------------------------------------------------------------------------------------------
	// Panels
	// --------------------------------------------------------------------------------------------

	toggleSidebar(open?: boolean, persist = true): void {
		const isOpen = this.mainEl.hasClass('epp-sidebar-open');
		const next = open ?? !isOpen;
		this.mainEl.toggleClass('epp-sidebar-open', next);
		if (persist && !Platform.isMobile && open === undefined) {
			this.plugin.settings.sidebarOpen = next;
			this.plugin.saveSettings();
		}
	}

	openSearch(): void {
		this.toggleSidebar(true, false);
		this.sidebar.showTab('search');
		const q = this.reader?.getSelection()?.text;
		this.sidebar.focusSearch(q && q.length < 100 ? q : undefined);
	}

	toggleAppearance(): void {
		this.appearance.toggle();
	}
}
