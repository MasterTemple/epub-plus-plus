import { EpubBook, EpubReader, parseLocator, type HighlightSpec, type LayerHit, type SelectionInfo, type TocItem } from '@epub-pp/core';
import { FileView, Menu, Notice, Platform, Scope, TFile, setIcon, type MenuItem, type WorkspaceLeaf } from 'obsidian';
import type { HighlightEntry } from './highlight-index';
import { ANNOTATION_MODES, type AnnotationMode, type HighlightGestureAction } from './settings';
import type EpubPlusPlus from './main';
import { HOVER_SOURCE, VIEW_TYPE_EPUB, layerId } from './constants';
import { AppearancePanel } from './appearance';
import { Sidebar } from './sidebar';
import { CommentCard } from './comment-card';
import { askForComment } from './comment-modal';
import { AnnotationTip } from './annotation-tip';
import type { AnnotationContext, AnnotationProvider, EpubAnnotation } from './api';

/** Annotations under the pointer, grouped by their provider. */
interface AnnotationGroup {
	provider: AnnotationProvider<unknown>;
	layer: string;
	annotations: EpubAnnotation[];
}

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
	private sidebar!: Sidebar;
	private searchNavEl!: HTMLElement;
	commentCard!: CommentCard;
	private appearance!: AppearancePanel;
	private pendingSubpath: string | null = null;
	private loadToken = 0;
	private offIndex: (() => void) | null = null;
	private annotationTip!: AnnotationTip;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: EpubPlusPlus,
	) {
		super(leaf);
		const last = plugin.settings.lastColor;
		this.activeColor = last === undefined ? plugin.settings.defaultColor || null : last;
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
		this.searchNavEl = this.mainEl.createDiv('epp-search-float');
		const navButton = (icon: string, label: string, delta: number) => {
			const b = this.searchNavEl.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', () => this.sidebar.step(delta));
		};
		navButton('chevron-up', 'Previous result', -1);
		navButton('chevron-down', 'Next result', 1);
		this.appearance = new AppearancePanel(this.plugin, this.mainEl.createDiv('epp-appearance'));
		this.commentCard = this.addChild(new CommentCard(this.app, this.mainEl));
		this.annotationTip = new AnnotationTip(this.mainEl);
		this.register(() => this.annotationTip.destroy());
		this.toggleSidebar(!Platform.isMobile && this.plugin.settings.sidebarOpen, false);

		this.offIndex = (() => {
			const ref = this.plugin.index.on('changed', (paths) => {
				if (this.file && paths.has(this.file.path)) this.refreshHighlights();
			});
			return () => this.plugin.index.offref(ref);
		})();
		this.registerEvent(this.app.workspace.on('css-change', () => this.reader?.updateSettings({})));
		// Dragging the tab into another window moves our DOM into a different document: rebuild the
		// reader there (highlights and ranges are per-window). Same-window moves are handled by core.
		this.register(
			this.contentEl.onWindowMigrated(() => {
				if (this.file && this.reader) this.onLoadFile(this.file);
			}),
		);
		this.guardTouchGestures();
		// Ctrl/Cmd+C (and the system Copy command) inside the book uses the configured copy action.
		this.registerDomEvent(this.contentEl, 'copy', (e: ClipboardEvent) => this.onCopy(e));
	}

	override async onOpen(): Promise<void> {}

	/** Floating previous/next buttons over the book while there are search results. */
	setSearchNavVisible(visible: boolean): void {
		this.searchNavEl?.toggleClass('is-visible', visible); // the sidebar is built before the nav buttons
	}

	override async onClose(): Promise<void> {
		this.contentEl.doc.body.removeClass('epp-drawer-open');
		this.appearance?.toggle(false);
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
				flash: { color: s.jumpHighlightColor, duration: s.jumpHighlightDuration },
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
			for (const p of this.plugin.providers.values()) void this.updateProvider(p);
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
		for (const p of this.plugin.providers.values()) void this.updateProvider(p);
	}

	private teardown(): void {
		this.reader?.destroy();
		this.book?.destroy();
		this.reader = null;
		this.book = null;
		this.sidebar?.setBook(null);
		this.hostEl?.empty();
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
		const ok = this.reader.goTo(target, { flash: flash && !!(loc.cfi || loc.textFragment) && this.plugin.jumpFlash() });
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
			if (Platform.isMobile) {
				// Wait a moment: this tap may be the first half of a double tap, or the end of a hold.
				const tappedAt = Date.now();
				if (tappedAt - this.lastHold < 1000) return;
				window.setTimeout(() => {
					if (this.lastDoubleTap >= tappedAt) return;
					this.runHighlightGesture(this.plugin.settings.highlightTap, entries, { x: e.clientX, y: e.clientY });
				}, 320);
			} else if (entries.length > 1) {
				const menu = new Menu();
				this.addHighlightItems(menu, entries);
				menu.showAtMouseEvent(e);
			} else this.plugin.openSource(entries[0], this);
		});
		reader.on('highlight-hover', (e, specs) => {
			// Touch screens emit a mouse move for every tap; hover cards/previews are desktop-only.
			if (Platform.isMobile) return;
			this.commentCard.hover(e, specs.map((s) => s.data as HighlightEntry));
			if (!specs.length) return;
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
		reader.on('annotation-click', (e, hits) => this.onAnnotationClick(e, hits));
		reader.on('annotation-hover', (e, hits) => {
			if (Platform.isMobile) return;
			const key = hits.map((h) => `${h.layer}:${h.spec.id}`).join('|');
			this.annotationTip.hover(e, key, () =>
				this.groupHits(hits)
					.flatMap((g) => g.annotations.map((a) => (g.provider.tooltip ? g.provider.tooltip(a, this.annotationContext(g.layer, a)) : a.label)))
					.filter((t): t is string => !!t)
					.join('\n'),
			);
		});
		reader.on('contextmenu', (e, { selection, highlights, annotations }) => {
			if (Platform.isMobile) {
				// Touch browsers fire contextmenu on long-press and when tapping a selection; that's what opens
				// the OS selection toolbar. After "System menu", leave it alone so the OS menu can open.
				if (this.nativeSelectionMode) return;
				if (highlights.length || annotations.length) {
					// Long-press on a highlight (Android fires contextmenu; the hold timer may have run already).
					e.preventDefault();
					if (Date.now() - this.lastHold > 1000) this.onHold(e.clientX, e.clientY);
					return;
				}
				const sel = selection ?? (this.reader?.getSelection() || null);
				if (sel && this.plugin.settings.selectionBar) {
					e.preventDefault();
					window.clearTimeout(this.selectionMenuTimer);
					if (sel.cfi !== this.lastMenuCfi || !this.pendingSelection) {
						this.lastMenuCfi = sel.cfi;
						this.showSelectionMenu(sel);
					}
					return;
				}
				if (!highlights.length) return; // plain long-press on text: let the OS select it
			}
			const info = selection ?? this.paragraphAt(e);
			if (!info && !highlights.length && !annotations.length) return;
			e.preventDefault();
			this.annotationTip.hide();
			const menu = new Menu();
			if (info) this.addSelectionItems(menu, info, !selection);
			if (highlights.length) this.addHighlightItems(menu, highlights.map((h) => h.data as HighlightEntry));
			if (annotations.length) this.addAnnotationItems(menu, annotations);
			menu.showAtMouseEvent(e);
		});
		reader.on('selectionchange', (sel) => this.scheduleSelectionMenu(sel));
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
		const all = this.plugin.index.get(this.file.path);
		const entries = this.plugin.settings.noColor === 'none' ? all.filter((e) => e.color) : all;
		const specs: HighlightSpec<HighlightEntry>[] = entries.map((e) => ({ id: e.id, locator: e.locator, color: e.color, data: e }));
		this.reader.setHighlights(specs);
		this.sidebar.setHighlights(all);
	}

	// --------------------------------------------------------------------------------------------
	// Annotations from other plugins (see api.ts)
	// --------------------------------------------------------------------------------------------

	/** Fetch a provider's annotations for this book and show them (drawn unless the user hid them). */
	async updateProvider(provider: AnnotationProvider<unknown>): Promise<void> {
		const reader = this.reader;
		const file = this.file;
		if (!reader?.isRendered || !file) return;
		let list: EpubAnnotation[];
		try {
			list = await provider.annotations(file);
		} catch (e) {
			console.error(`[epub-pp] annotation provider ${provider.id} failed`, e);
			list = [];
		}
		if (this.reader !== reader || this.file !== file || this.plugin.providers.get(provider.id) !== provider) return;
		const specs: HighlightSpec<EpubAnnotation>[] = list.map((a) => ({ id: a.id, locator: a.locator, color: a.color ?? provider.color, data: a }));
		const hidden = this.plugin.settings.hiddenProviders.includes(provider.id);
		reader.setLayer(layerId(provider.id), specs, { style: provider.style, hidden });
		this.sidebar.setProvider(provider, hidden);
	}

	removeProvider(id: string): void {
		this.reader?.removeLayer(layerId(id));
		this.sidebar.removeProvider(id);
	}

	private groupHits(hits: LayerHit[]): AnnotationGroup[] {
		const groups = new Map<string, AnnotationGroup>();
		for (const h of hits) {
			const provider = this.plugin.providers.get(h.layer.replace(/^provider:/, ''));
			if (!provider) continue;
			let g = groups.get(h.layer);
			if (!g) groups.set(h.layer, (g = { provider, layer: h.layer, annotations: [] }));
			g.annotations.push(h.spec.data as EpubAnnotation);
		}
		return [...groups.values()];
	}

	annotationContext(layer: string, a: EpubAnnotation): AnnotationContext {
		const range = this.reader?.layerRange(layer, a.id) ?? null;
		return {
			file: this.file!,
			text: range?.toString().replace(/\s+/g, ' ').trim() ?? '',
			chapter: (range && this.reader?.tocItemAt(range)?.label) || null,
		};
	}

	private onAnnotationClick(e: MouseEvent, hits: LayerHit[]): void {
		const group = this.groupHits(hits)[0];
		if (!group) return;
		const handled = () => !!group.provider.onClick?.(group.annotations, e, this.annotationContext(group.layer, group.annotations[0]));
		if (!Platform.isMobile) {
			handled();
			return;
		}
		// As with highlights: this tap may be the first half of a double tap, or the end of a hold.
		const tappedAt = Date.now();
		if (tappedAt - this.lastHold < 1000) return;
		const at = { x: e.clientX, y: e.clientY };
		window.setTimeout(() => {
			if (this.lastDoubleTap >= tappedAt) return;
			if (!handled()) this.showAnnotationMenu(hits, at);
		}, 320);
	}

	private showAnnotationMenu(hits: LayerHit[], at: { x: number; y: number }): void {
		const menu = new Menu();
		this.addAnnotationItems(menu, hits);
		menu.onHide(() => this.afterMenuHidden());
		menu.showAtPosition(at);
	}

	/** "Save as highlight" / "Save with comment" for each annotation, then the provider's own items. */
	addAnnotationItems(menu: Menu, hits: LayerHit[]): void {
		const groups = this.groupHits(hits);
		const many = groups.reduce((n, g) => n + g.annotations.length, 0) > 1;
		for (const g of groups) {
			for (const a of g.annotations) {
				const section = `epp-ann-${g.provider.id}-${a.id}`;
				if (many) menu.addItem((i) => (i.setTitle(`${g.provider.name}: ${a.label}`) as any).setIsLabel?.(true).setSection?.(section));
				this.addColorItem(menu, 'Save as highlight', 'highlighter', section, (c) => this.plugin.saveAnnotation(this, g.layer, a, c, false));
				menu.addItem((i) =>
					i
						.setTitle('Save with comment…')
						.setIcon('message-square-plus')
						.setSection(section)
						.onClick(() => this.plugin.saveAnnotation(this, g.layer, a, this.activeColor, true)),
				);
			}
			try {
				g.provider.menu?.(menu, g.annotations, this.annotationContext(g.layer, g.annotations[0]));
			} catch (e) {
				console.error(`[epub-pp] annotation provider ${g.provider.id} menu failed`, e);
			}
		}
	}

	/**
	 * Touch gestures inside the view:
	 * - Vertical: Obsidian mobile opens its pull-down action (command palette) on a downward swipe when
	 *   the view looks scrolled to the top, and our scroller lives in a shadow root, so it always looks
	 *   that way. Keep vertical swipes in the reader unless it really is at the top.
	 * - Horizontal (mobile): a swipe that would open Obsidian's left drawer opens our sidebar first; if
	 *   it's already open, the swipe goes to Obsidian. Swiping back closes our sidebar.
	 */
	private guardTouchGestures(): void {
		let x0 = 0;
		let y0 = 0;
		let t0 = 0;
		let dx = 0;
		let axis: 'x' | 'y' | null = null;
		let inReader = false;
		let mine: 'open' | 'close' | null = null;
		const readerScrolled = () => inReader && !!this.reader && this.reader.scroller.scrollTop > 0;
		const start = (e: TouchEvent) => {
			const t = e.touches[0];
			inReader = this.hostEl.contains(e.target as Node);
			if (inReader) {
				this.touching = true;
				this.lastMenuCfi = null; // a new interaction may reselect the same text
			}
			x0 = t?.clientX ?? 0;
			y0 = t?.clientY ?? 0;
			t0 = Date.now();
			window.clearTimeout(this.holdTimer);
			if (inReader && Platform.isMobile && e.touches.length === 1) {
				const hx = x0;
				const hy = y0;
				this.holdTimer = window.setTimeout(() => {
					if (axis === null && this.touching) this.onHold(hx, hy);
				}, 450);
			}
			dx = 0;
			axis = null;
			mine = null;
		};
		const move = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!t) return;
			dx = t.clientX - x0;
			const dy = t.clientY - y0;
			if (axis === null && Math.abs(dx) + Math.abs(dy) > 8) {
				window.clearTimeout(this.holdTimer);
				axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
				// A drag that starts after a long press is adjusting a text selection, not a swipe.
				const longPress = Date.now() - t0 > 350 || !!this.reader?.getSelectionRange();
				if (axis === 'x' && Platform.isMobile && !longPress) {
					const open = this.mainEl.hasClass('epp-sidebar-open');
					mine = dx > 0 ? (open ? null : 'open') : open ? 'close' : null;
				}
			}
			if ((axis === 'y' && readerScrolled()) || mine) e.stopPropagation();
		};
		const end = (e: TouchEvent) => {
			window.clearTimeout(this.holdTimer);
			if (Date.now() - this.lastHold < 1000) {
				// The hold already acted; this release must not count as a tap, nor produce the synthetic
				// mousedown/click that would close the menu it opened.
				e.preventDefault();
				this.touching = false;
				this.lastTap = { t: 0, x: 0, y: 0 };
				return;
			}
			if (axis === null && inReader && Date.now() - t0 < 300 && this.handleTap(e)) {
				this.touching = false;
				return;
			}
			if (e.touches.length === 0 && inReader) {
				this.touching = false;
				this.scheduleSelectionMenu(this.reader?.getSelection() ?? null);
			}
			if (axis === 'y' && readerScrolled()) e.stopPropagation();
			if (mine) {
				e.stopPropagation();
				if (mine === 'open' && dx > 50) this.toggleSidebar(true, false);
				else if (mine === 'close' && dx < -50) this.toggleSidebar(false, false);
				mine = null;
			}
		};
		this.registerDomEvent(this.mainEl, 'touchstart', start, { passive: true });
		this.registerDomEvent(this.mainEl, 'touchmove', move, { passive: true });
		// Not passive: a double tap prevents the browser's own double-tap handling (zoom / word select).
		this.registerDomEvent(this.mainEl, 'touchend', end, { passive: false });
		this.registerDomEvent(this.mainEl, 'touchcancel', end, { passive: true });
	}

	private lastTap = { t: 0, x: 0, y: 0 };
	private lastDoubleTap = 0;
	private lastHold = 0;
	private holdTimer = 0;

	/** A long press: when it is on a highlight, run the configured action and keep the OS selection away. */
	private onHold(x: number, y: number): void {
		const hits = this.reader?.highlightsAt(x, y) ?? [];
		const annotations = hits.length ? [] : (this.reader?.layerHitsAt(x, y) ?? []);
		if (!hits.length && !annotations.length) return;
		this.lastHold = Date.now();
		window.clearTimeout(this.selectionMenuTimer);
		const doc = this.contentEl.doc;
		// The OS starts selecting the word under a long press; drop that selection.
		for (const ms of [0, 120, 400]) window.setTimeout(() => doc.getSelection()?.removeAllRanges(), ms);
		if (annotations.length) return this.showAnnotationMenu(annotations, { x, y });
		this.runHighlightGesture(this.plugin.settings.highlightHold, hits.map((h) => h.data as HighlightEntry), { x, y });
	}

	/** Mobile gestures on highlights (see settings). Several overlapping highlights open the menu. */
	runHighlightGesture(action: HighlightGestureAction, entries: HighlightEntry[], at: { x: number; y: number }): void {
		const entry = entries[0];
		if (!entry || action === 'none') return;
		if (entries.length > 1 && action !== 'select') action = 'menu';
		switch (action) {
			case 'open':
				void this.plugin.openSource(entry, this);
				break;
			case 'comment':
				void this.editComment(entry);
				break;
			case 'color':
				this.openColorMenu(at, entry.color ?? null, (c) => {
					this.setActiveColor(c);
					void this.plugin.setHighlightColor(entry, c);
				});
				break;
			case 'copy-link':
				void navigator.clipboard.writeText(entry.original).then(() => new Notice('Copied link to clipboard'));
				break;
			case 'select': {
				const range = this.reader?.highlightRange(entry.id);
				const block = range && (range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, div:not(.epp-body):not(.epp-html)');
				if (!block) break;
				const r = block.ownerDocument.createRange();
				r.selectNodeContents(block);
				const info = this.reader?.describeRange(r);
				if (info) {
					this.lastMenuCfi = info.cfi;
					this.showSelectionMenu(info);
				}
				break;
			}
			case 'menu': {
				void this.commentCard.show(entries, 'top');
				const menu = new Menu();
				this.addHighlightItems(menu, entries);
				menu.onHide(() => {
					this.commentCard.hide();
					this.afterMenuHidden();
				});
				menu.showAtPosition(at);
				break;
			}
		}
	}

	/** Mobile: a double tap selects the paragraph under the finger and opens EPUB++'s menu. */
	private handleTap(e: TouchEvent): boolean {
		const touch = e.changedTouches[0];
		if (!touch || !Platform.isMobile || !this.reader) return false;
		const now = Date.now();
		const prev = this.lastTap;
		this.lastTap = { t: now, x: touch.clientX, y: touch.clientY };
		if (now - prev.t > 350 || Math.hypot(touch.clientX - prev.x, touch.clientY - prev.y) > 30) return false;
		this.lastTap = { t: 0, x: 0, y: 0 };
		const hits = this.reader.highlightsAt(touch.clientX, touch.clientY);
		if (hits.length && this.plugin.settings.highlightDoubleTap !== 'select') {
			e.preventDefault();
			this.lastDoubleTap = now;
			this.runHighlightGesture(this.plugin.settings.highlightDoubleTap, hits.map((h) => h.data as HighlightEntry), { x: touch.clientX, y: touch.clientY });
			return true;
		}
		const target = e.composedPath()[0] as Node | undefined;
		const el = target?.nodeType === 1 ? (target as Element) : target?.parentElement;
		const block = el?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, div:not(.epp-body):not(.epp-html)');
		if (!block || !this.reader.content.contains(block) || !block.textContent?.trim()) return false;
		e.preventDefault();
		this.lastDoubleTap = now;
		this.nativeSelectionMode = false;
		const range = block.ownerDocument.createRange();
		range.selectNodeContents(block);
		const sel = block.ownerDocument.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		window.clearTimeout(this.selectionMenuTimer);
		window.setTimeout(() => {
			const info = this.reader?.describeRange(range);
			if (!info) return;
			this.lastMenuCfi = info.cfi;
			this.showSelectionMenu(info);
		}, 60);
		return true;
	}

	private onCopy(e: ClipboardEvent): void {
		const what = this.plugin.resolveCopyAction(this.plugin.settings.copyAction);
		if (!what || !e.clipboardData) return; // default browser copy
		const sel = this.reader?.getSelection();
		if (!sel) return;
		if (what === 'text') {
			if (!this.plugin.settings.copyMarkdown) return; // default browser copy
			// Markdown as plain text; keep the book's HTML for rich-text targets.
			const holder = sel.range.startContainer.ownerDocument!.createElement('div');
			holder.appendChild(sel.range.cloneContents());
			e.clipboardData.setData('text/plain', this.plugin.selectionText(sel));
			e.clipboardData.setData('text/html', holder.innerHTML);
			e.preventDefault();
			return;
		}
		if (this.plugin.asksForComment(what)) {
			// Needs a prompt first, so it can't fill this (synchronous) copy event.
			e.preventDefault();
			this.plugin.copy(this, sel, what, this.activeColor);
			return;
		}
		const text = this.plugin.renderCopy(this, sel, what, this.activeColor);
		e.clipboardData.setData('text/plain', text);
		// Ctrl/Cmd+C always copies; it also inserts when the annotation file's mode asks for it.
		const ann = this.file ? this.plugin.annotations.find(this.file) : null;
		if (ann && this.plugin.annotations.mode(ann) !== 'copy') {
			e.preventDefault();
			this.plugin.addToAnnotationFile(this, ann, sel, text, true);
			return;
		}
		e.preventDefault();
		new Notice(`Copied ${this.plugin.copyLabel(what)}`);
	}

	/** Re-apply jump-highlight settings to an open reader. */
	applyFlashSettings(): void {
		const s = this.plugin.settings;
		this.reader?.setFlashDefaults({ color: s.jumpHighlightColor, duration: s.jumpHighlightDuration });
	}

	applyPalette(): void {
		this.renderPalette();
		this.reader?.setPalette(this.plugin.paletteRecord(), this.plugin.settings.defaultColor);
	}

	renderPalette(): void {
		const el = this.paletteEl;
		el.empty();
		const add = (name: string | null, color: string, label: string) => {
			const sw = el.createDiv({ cls: 'epp-swatch', attr: { 'aria-label': label } });
			sw.style.setProperty('--swatch', color);
			if (!name) sw.addClass('epp-swatch-none');
			sw.toggleClass('is-active', this.activeColor === name);
			sw.addEventListener('click', () => {
				this.setActiveColor(name);
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

	/** Remember the color picked last; it is what tapping a colored menu item uses next time. */
	setActiveColor(color: string | null): void {
		this.activeColor = color;
		this.plugin.settings.lastColor = color;
		this.plugin.saveSettings();
		for (const v of this.plugin.epubViews()) v.renderPalette();
	}

	/**
	 * A menu item that runs `action(color)`. Tapping the item uses the previous color; the arrow at its
	 * end (with a generous tap area) opens a color picker instead.
	 */
	private addColorItem(menu: Menu, title: string, icon: string, section: string, action: (color: string | null) => void, checked?: string | null): void {
		menu.addItem((item) => {
			item.setTitle(title).setIcon(icon).setSection(section).onClick(() => action(this.activeColor));
			const dom = (item as MenuItem & { dom?: HTMLElement }).dom;
			if (!dom) return;
			const picker = dom.createDiv({ cls: 'epp-menu-color-picker', attr: { 'aria-label': 'Choose color' } });
			const sw = picker.createSpan({ cls: 'epp-menu-swatch' });
			sw.style.setProperty('--swatch', this.colorCss(this.activeColor));
			if (!this.activeColor) sw.addClass('epp-swatch-none');
			setIcon(picker.createSpan({ cls: 'epp-menu-chevron' }), 'chevron-right');
			// Keep these events away from the menu item so it doesn't run its own action.
			for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'])
				picker.addEventListener(type, (e) => e.stopPropagation());
			picker.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				const r = picker.getBoundingClientRect();
				this.keepPendingSelection = true;
				menu.hide();
				this.openColorMenu({ x: r.right, y: r.top }, checked === undefined ? this.activeColor : checked, (c) => {
					this.setActiveColor(c);
					action(c);
				});
			});
		});
	}

	private colorCss(name: string | null): string {
		if (!name) return 'transparent';
		return this.plugin.settings.palette.find((p) => p.name === name)?.color ?? name;
	}

	private openColorMenu(at: { x: number; y: number }, checked: string | null, onPick: (color: string | null) => void): void {
		const m = new Menu();
		for (const c of [...this.plugin.settings.palette.map((p) => p.name), null])
			m.addItem((i) => i.setTitle(this.colorTitle(c)).setChecked(c === checked).onClick(() => onPick(c)));
		m.onHide(() => this.afterMenuHidden());
		m.showAtPosition(at);
	}

	/** Selection menu, in the order and with the items configured in settings. */
	addSelectionItems(menu: Menu, info: SelectionInfo, isParagraph = false): void {
		const s = this.plugin.settings;
		const section = 'epp-selection';
		if (isParagraph) menu.addItem((i) => (i.setTitle('Paragraph') as any).setIsLabel?.(true).setSection?.(section));
		for (const entry of s.selectionMenu) {
			if (!entry.show) continue;
			if (entry.id === 'link') {
				this.addColorItem(menu, 'Copy link', 'link', section, (c) => this.plugin.copy(this, info, 'link', c));
			} else if (entry.id === 'alt-link') {
				menu.addItem((i) =>
					i
						.setTitle(s.linkType === 'cfi' ? 'Copy text-fragment link' : 'Copy CFI link')
						.setIcon('link-2')
						.setSection(section)
						.onClick(() => this.plugin.copy(this, info, 'alt-link', this.activeColor)),
				);
			} else if (entry.id === 'text') {
				menu.addItem((i) => i.setTitle('Copy text').setIcon('copy').setSection(section).onClick(() => this.plugin.copy(this, info, 'text', null)));
			} else if (entry.id.startsWith('format:')) {
				const fmt = s.copyFormats.find((f) => `format:${f.id}` === entry.id);
				if (!fmt) continue;
				const lower = fmt.name.toLowerCase();
				const icon = this.plugin.asksForComment(fmt) ? 'message-square-quote' : lower.includes('callout') ? 'quote' : 'clipboard-copy';
				this.addColorItem(menu, `Copy as ${lower}${this.plugin.asksForComment(fmt) ? '…' : ''}`, icon, section, (c) => this.plugin.copy(this, info, fmt, c));
			}
		}
		const ann = this.file && this.plugin.annotations.find(this.file);
		if (ann) this.addAnnotationModeRow(menu, ann);
	}

	/** Prompt for a highlight's comment and write it into the note. */
	async editComment(entry: HighlightEntry): Promise<void> {
		const quote = this.reader?.highlightRange(entry.id)?.toString().replace(/\s+/g, ' ').trim() ?? '';
		const comment = await askForComment(this.app, quote, {
			title: entry.comment ? 'Edit comment' : 'Add comment',
			initial: entry.comment ?? '',
			submit: 'Save',
		});
		if (comment === null) return;
		await this.plugin.setHighlightComment(entry, comment);
	}

	/** `[Copy | Insert | Both]`: what the items above do for this book's annotation file. */
	private addAnnotationModeRow(menu: Menu, ann: TFile): void {
		menu.addItem((item) => {
			item.setSection('epp-annotation');
			const dom = (item as MenuItem & { dom?: HTMLElement }).dom;
			if (!dom) return;
			dom.empty();
			dom.addClass('epp-mode-row');
			dom.setAttr('aria-label', `When copying, for ${ann.basename}`);
			const labels: Record<AnnotationMode, string> = { copy: 'Copy', insert: 'Insert', both: 'Both' };
			const buttons: HTMLElement[] = [];
			const current = this.plugin.annotations.mode(ann);
			for (const mode of ANNOTATION_MODES) {
				const b = dom.createDiv({ cls: 'epp-mode-button', text: labels[mode] });
				b.toggleClass('is-active', mode === current);
				buttons.push(b);
				for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'])
					b.addEventListener(type, (e) => e.stopPropagation());
				b.addEventListener('click', async (e) => {
					e.preventDefault();
					e.stopPropagation();
					buttons.forEach((x) => x.toggleClass('is-active', x === b));
					await this.plugin.annotations.setMode(ann, mode);
				});
			}
		});
	}

	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (!this.file || !this.reader) return;
		const ann = this.plugin.annotations.find(this.file);
		menu.addItem((i) =>
			i
				.setTitle(ann ? 'Open annotation file' : 'Create annotation file')
				.setIcon('notebook-pen')
				.setSection('open')
				.onClick(() => this.plugin.openAnnotationFile(this)),
		);
	}

	/** Highlight menu, in the order and with the items configured in settings. */
	addHighlightItems(menu: Menu, entries: HighlightEntry[]): void {
		const order = this.plugin.settings.highlightMenu.filter((e) => e.show).map((e) => e.id);
		for (const entry of entries) {
			const section = `epp-hl-${entry.id}`;
			const note = entry.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? entry.sourcePath;
			if (entries.length > 1) menu.addItem((i) => (i.setTitle(`Highlight in "${note}"`) as any).setIsLabel?.(true).setSection?.(section));
			for (const id of order) {
				if (id === 'open') menu.addItem((i) => i.setTitle(`Open in "${note}"`).setIcon('file-text').setSection(section).onClick(() => this.plugin.openSource(entry, this)));
				else if (id === 'color')
					this.addColorItem(menu, 'Change color', 'palette', section, (c) => this.plugin.setHighlightColor(entry, c), entry.color ?? null);
				else if (id === 'comment')
					menu.addItem((i) =>
						i
							.setTitle(entry.comment ? 'Edit comment' : 'Add comment')
							.setIcon(entry.comment ? 'message-square-text' : 'message-square-plus')
							.setSection(section)
							.onClick(() => this.editComment(entry)),
					);
				else if (id === 'copy-link')
					menu.addItem((i) =>
						i
							.setTitle('Copy link')
							.setIcon('link')
							.setSection(section)
							.onClick(async () => {
								await navigator.clipboard.writeText(entry.original);
								new Notice('Copied link to clipboard');
							}),
					);
			}
		}
	}

	// --------------------------------------------------------------------------------------------
	// Selection bar (mobile: there is no right-click)
	// --------------------------------------------------------------------------------------------

	private selectionMenuTimer = 0;
	/** CFI of the selection the menu was last shown for (don't re-open it for the same selection). */
	private lastMenuCfi: string | null = null;
	private touching = false;
	/** The selection our mobile menu is acting on (drawn by us while the native one is dropped). */
	private pendingSelection: Range | null = null;
	private restoreNativeSelection = false;
	/**
	 * After "System menu", the restored selection belongs to the OS: don't take it over again (a tap on
	 * it would otherwise re-open our menu and drop it) until the selection is cleared.
	 */
	private nativeSelectionMode = false;
	/** Set while one EPUB++ menu hands over to another (e.g. the color picker). */
	keepPendingSelection = false;

	/** Mobile has no right-click: open EPUB++'s menu once a selection settles (not while touching). */
	private scheduleSelectionMenu(sel: SelectionInfo | null): void {
		window.clearTimeout(this.selectionMenuTimer);
		if (!Platform.isMobile || !this.plugin.settings.selectionBar) return;
		if (!sel) {
			if (!this.pendingSelection) this.nativeSelectionMode = false;
			return;
		}
		if (this.nativeSelectionMode || Date.now() - this.lastHold < 1500) return;
		this.selectionMenuTimer = window.setTimeout(() => {
			if (this.touching || this.nativeSelectionMode) return; // touchend reschedules
			const cur = this.reader?.getSelection();
			if (!cur || cur.cfi === this.lastMenuCfi) return;
			this.lastMenuCfi = cur.cfi;
			this.showSelectionMenu(cur);
		}, 500);
	}

	private showSelectionMenu(info: SelectionInfo): void {
		// The OS toolbar is tied to the native selection: drop it while our menu is open and paint the
		// selected text ourselves instead.
		this.pendingSelection = info.range;
		this.reader?.setPendingSelection(info.range);
		info.range.startContainer.ownerDocument?.getSelection()?.removeAllRanges();

		const menu = new Menu();
		this.addSelectionItems(menu, info);
		menu.addItem((i) =>
			i
				.setTitle('System menu')
				.setIcon('smartphone')
				.setSection('epp-system')
				.onClick(() => (this.restoreNativeSelection = true)),
		);
		menu.onHide(() => this.afterMenuHidden());
		const r = info.range.getBoundingClientRect();
		menu.showAtPosition({ x: r.left + r.width / 2, y: r.bottom + 8 });
	}

	/** Called whenever one of our menus closes: finish the selection session unless another menu took over. */
	afterMenuHidden(): void {
		window.setTimeout(() => {
			if (this.keepPendingSelection) {
				this.keepPendingSelection = false;
				return;
			}
			const range = this.pendingSelection;
			this.pendingSelection = null;
			this.reader?.setPendingSelection(null);
			if (range && this.restoreNativeSelection) {
				// After the tap on the menu has fully finished, so it can't collapse the selection again.
				// lastMenuCfi still matches, so this doesn't re-open our menu.
				window.setTimeout(() => {
					const sel = range.startContainer.ownerDocument?.getSelection();
					sel?.removeAllRanges();
					sel?.addRange(range);
					// Only now: "selection cleared" events from the gap before this must not end the mode.
					this.nativeSelectionMode = true;
					new Notice('Tap the selected text to open the system menu', 3000);
				}, 250);
			}
			this.restoreNativeSelection = false;
		}, 50);
	}

	// --------------------------------------------------------------------------------------------
	// Panels
	// --------------------------------------------------------------------------------------------

	toggleSidebar(open?: boolean, persist = true): void {
		const isOpen = this.mainEl.hasClass('epp-sidebar-open');
		const next = open ?? !isOpen;
		this.mainEl.toggleClass('epp-sidebar-open', next);
		// Obsidian's mobile navbar overlaps the drawer's bottom; hide it while the drawer is open.
		this.contentEl.doc.body.toggleClass('epp-drawer-open', next && this.sidebarIsOverlay());
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
