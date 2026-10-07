import { EpubBook, formatLocator, type ReaderSettings, type SelectionInfo } from '@epub-pp/core';
import { around } from 'monkey-around';
import {
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TFile,
	parseLinktext,
	type PaneType,
	type Workspace,
	type WorkspaceLeaf,
	type OpenViewState,
} from 'obsidian';
import { HighlightIndex, resolveEpub, type HighlightEntry } from './highlight-index';
import { formatLink, linkAt, renderTemplate, setCalloutColor, setLinkColor } from './link-utils';
import { COMMENT_TEMPLATE, DEFAULT_SETTINGS, needsComment, newFormatId, syncMenus, type CopyAction, type CopyFormat, type EppSettings, type OpenTarget } from './settings';
import { Annotations } from './annotations';
import { askForComment } from './comment-modal';
import { setComment } from './comment-utils';
import { registerEpubEmbeds } from './embed';
import { EppSettingTab } from './setting-tab';
import { EpubView, VIEW_TYPE_EPUB } from './view';

import { EDITOR_HOVER_SOURCE, HOVER_SOURCE } from './constants';

export type CopyTarget = CopyFormat | 'link' | 'alt-link' | 'text';

export default class EpubPlusPlus extends Plugin {
	declare settings: EppSettings;
	index!: HighlightIndex;
	annotations = new Annotations(this);
	private calloutStyle: HTMLStyleElement | null = null;
	private savePositionsTimer = 0;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.index = new HighlightIndex(this.app);

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubView(leaf, this));
		this.registerExtensions(['epub'], VIEW_TYPE_EPUB);
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'EPUB++ highlights', defaultMod: true });
		// Obsidian's own editor previews need Ctrl/Cmd; this source (toggleable under Page preview)
		// previews EPUB links in the editor on plain hover, like Reading view does.
		this.registerHoverLinkSource(EDITOR_HOVER_SOURCE, { display: 'EPUB++: EPUB links in the editor', defaultMod: false });
		this.registerEditorHover();
		this.addSettingTab(new EppSettingTab(this.app, this));
		this.patchLinkOpening();
		this.registerIndexEvents();
		this.registerCommands();
		this.updateCalloutStyles();
		this.registerBacklinkHover();
		this.updatePreviews();
	}

	private registerEditorHover(): void {
		this.registerDomEvent(document, 'mouseover', (e) => {
			if (!this.settings.previews || e.ctrlKey || e.metaKey) return; // with a modifier Obsidian handles it
			const el = (e.target as HTMLElement | null)?.closest?.('.cm-hmd-internal-link, .cm-link, .cm-url, .cm-underline');
			if (!el || !el.closest('.markdown-source-view')) return;
			let view: MarkdownView | null = null;
			this.app.workspace.iterateAllLeaves((l) => {
				if (!view && l.view instanceof MarkdownView && l.view.containerEl.contains(el)) view = l.view;
			});
			const mdView = view as MarkdownView | null;
			const cm = (mdView?.editor as any)?.cm;
			if (!mdView?.file || !cm?.posAtDOM) return;
			let linktext: string | null = null;
			try {
				const pos = cm.posAtDOM(el, 0);
				const line = cm.state.doc.lineAt(pos);
				linktext = linkAt(line.text, pos - line.from + 1);
			} catch {
				return;
			}
			if (!linktext) return;
			const { path } = parseLinktext(linktext);
			if (!resolveEpub(this.app, path, mdView.file.path)) return;
			this.app.workspace.trigger('hover-link', {
				event: e,
				source: EDITOR_HOVER_SOURCE,
				hoverParent: mdView,
				targetEl: el,
				linktext,
				sourcePath: mdView.file.path,
			});
		});
	}

	/** Register or unregister the EPUB embed (used by `![[book.epub#…]]` and link hover previews). */
	updatePreviews(): void {
		this.unregisterEmbeds?.();
		this.unregisterEmbeds = this.settings.previews ? registerEpubEmbeds(this) : null;
	}
	private unregisterEmbeds: (() => void) | null = null;

	/** Flash options for jumps, from settings (null when disabled). */
	jumpFlash(): { duration: number; color: string } | false {
		const s = this.settings;
		return s.jumpHighlight ? { duration: s.jumpHighlightDuration, color: s.jumpHighlightColor } : false;
	}

	// --------------------------------------------------------------------------------------------
	// Book cache (previews open the same books repeatedly)
	// --------------------------------------------------------------------------------------------

	private books = new Map<string, { mtime: number; book: Promise<EpubBook> }>();

	getBook(file: TFile): Promise<EpubBook> {
		const hit = this.books.get(file.path);
		if (hit && hit.mtime === file.stat.mtime) {
			// refresh LRU order
			this.books.delete(file.path);
			this.books.set(file.path, hit);
			return hit.book;
		}
		const book = this.app.vault.readBinary(file).then((data) => EpubBook.open(data));
		this.books.set(file.path, { mtime: file.stat.mtime, book });
		while (this.books.size > 3) {
			const [oldest, entry] = this.books.entries().next().value!;
			this.books.delete(oldest);
			// Let previews that still use it finish; blob URLs are revoked a bit later.
			entry.book.then((b) => window.setTimeout(() => b.destroy(), 60_000)).catch(() => {});
		}
		book.catch(() => this.books.delete(file.path));
		return book;
	}

	override onunload(): void {
		this.calloutStyle?.remove();
		this.unregisterEmbeds?.();
		for (const { book } of this.books.values()) book.then((b) => b.destroy()).catch(() => {});
	}

	// --------------------------------------------------------------------------------------------
	// Settings
	// --------------------------------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		const defaults = structuredClone(DEFAULT_SETTINGS);
		this.settings = { ...defaults, ...data, reader: { ...defaults.reader, ...(data.reader ?? {}) } };
		// Formats saved before format ids existed.
		for (const f of this.settings.copyFormats) f.id ||= newFormatId();
		if ((data.settingsVersion ?? 1) < 2) {
			// v2 added the comment callout format; offer it to existing setups once.
			if (!this.settings.copyFormats.some((f) => needsComment(f.template)))
				this.settings.copyFormats.splice(1, 0, { id: 'callout-comment', name: 'Callout with comment', template: COMMENT_TEMPLATE });
			this.settings.settingsVersion = 2;
		}
		syncMenus(this.settings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Apply reader settings to every open EPUB view and persist them. */
	async updateReaderSettings(patch: Partial<ReaderSettings>): Promise<void> {
		this.settings.reader = { ...this.settings.reader, ...patch };
		for (const v of this.epubViews()) v.reader?.updateSettings(this.settings.reader);
		await this.saveSettings();
	}

	/** Re-apply palette/opacity to views and callout CSS. */
	refreshPalette(): void {
		this.updateCalloutStyles();
		for (const v of this.epubViews()) v.applyPalette();
	}

	savePosition(path: string, cfi: string): void {
		this.settings.positions[path] = cfi;
		window.clearTimeout(this.savePositionsTimer);
		this.savePositionsTimer = window.setTimeout(() => this.saveSettings(), 2000);
	}

	paletteRecord(): Record<string, string> {
		return Object.fromEntries(this.settings.palette.map((p) => [p.name, p.color]));
	}

	epubViews(): EpubView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB).map((l) => l.view).filter((v): v is EpubView => v instanceof EpubView);
	}

	private updateCalloutStyles(): void {
		this.calloutStyle ??= document.head.createEl('style', { attr: { id: 'epub-plus-plus-callouts' } });
		this.calloutStyle.textContent = this.settings.palette
			.map((p) => {
				const rgb = toRgb(p.color);
				return rgb ? `.callout[data-callout-metadata="${CSS.escape(p.name)}"] { --callout-color: ${rgb}; }` : '';
			})
			.join('\n');
	}

	// --------------------------------------------------------------------------------------------
	// Highlight index
	// --------------------------------------------------------------------------------------------

	private registerIndexEvents(): void {
		const { metadataCache, vault, workspace } = this.app;
		workspace.onLayoutReady(() => {
			const ready = () => this.index.rebuild();
			// resolvedLinks is only complete after the initial resolve pass.
			if ((metadataCache as any).initialized === false) this.registerEvent(metadataCache.on('resolved', ready));
			ready();
		});
		this.registerEvent(metadataCache.on('changed', (file) => file.extension === 'md' && this.index.indexFile(file)));
		this.registerEvent(metadataCache.on('deleted', (file) => this.index.removeSource(file.path, true)));
		let rebuildTimer = 0;
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === 'md') {
					this.index.removeSource(oldPath, true);
					this.index.indexFile(file);
				} else if (file.extension === 'epub') {
					const pos = this.settings.positions[oldPath];
					if (pos) {
						delete this.settings.positions[oldPath];
						this.savePosition(file.path, pos);
					}
					window.clearTimeout(rebuildTimer);
					rebuildTimer = window.setTimeout(() => this.index.rebuild(), 1000);
				}
			}),
		);
	}

	// --------------------------------------------------------------------------------------------
	// Link opening
	// --------------------------------------------------------------------------------------------

	/**
	 * Intercept link opening so EPUB links (wiki or markdown, CFI or text fragment) reuse an existing
	 * EPUB tab and scroll it instead of reopening the file, and open in a split by default.
	 */
	private patchLinkOpening(): void {
		const plugin = this;
		this.register(
			around(this.app.workspace, {
				openLinkText(old) {
					return async function (this: Workspace, linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, state?: OpenViewState) {
						try {
							const { path, subpath } = parseLinktext(linktext);
							const file = path ? resolveEpub(plugin.app, path, sourcePath) : null;
							if (file) return await plugin.openEpub(file, subpath, newLeaf, state);
						} catch (e) {
							console.error('[epub-pp] link interception failed', e);
						}
						return old.call(this, linktext, sourcePath, newLeaf, state);
					};
				},
			}),
		);
	}

	async openEpub(file: TFile, subpath: string, newLeaf?: PaneType | boolean, state?: OpenViewState): Promise<void> {
		const { workspace } = this.app;
		if (!newLeaf) {
			const existing = this.epubViews().find((v) => v.file?.path === file.path);
			if (existing) {
				workspace.revealLeaf(existing.leaf);
				if (subpath) existing.navigate(subpath);
				return;
			}
		}
		let leaf: WorkspaceLeaf;
		if (newLeaf) leaf = workspace.getLeaf(newLeaf);
		else leaf = this.leafFor(this.settings.openEpubIn, () => workspace.getActiveViewOfType(MarkdownView) !== null);
		await leaf.openFile(file, { ...state, active: true, eState: { ...(state?.eState ?? {}), subpath: subpath || undefined } });
	}

	/** Pick a leaf according to a setting; `split` reuses an adjacent leaf when one exists. */
	private leafFor(target: OpenTarget, preferSplit: () => boolean): WorkspaceLeaf {
		const { workspace } = this.app;
		if (target === 'current' || Platform.isPhone) return workspace.getLeaf(false);
		if (target === 'tab') return workspace.getLeaf('tab');
		if (!preferSplit()) return workspace.getLeaf(false);
		return workspace.getLeaf('split', 'vertical');
	}

	// --------------------------------------------------------------------------------------------
	// Highlight actions
	// --------------------------------------------------------------------------------------------

	/** Open the note containing a highlight's link, at the link's line. */
	async openSource(entry: HighlightEntry, fromView?: EpubView): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		const { workspace } = this.app;
		const eState = { line: entry.position.start.line };
		let leaf = workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file?.path === file.path) ?? null;
		if (leaf) {
			workspace.revealLeaf(leaf);
			leaf.setEphemeralState(eState);
		} else {
			const target = this.settings.openNoteIn;
			if (target === 'current' || Platform.isPhone || !fromView) leaf = workspace.getLeaf(Platform.isPhone ? false : 'tab');
			else if (target === 'tab') leaf = workspace.getLeaf('tab');
			else {
				// Prefer an existing markdown leaf in another split over creating a new one.
				const other = workspace.getLeavesOfType('markdown').find((l) => l.getRoot() === fromView.leaf.getRoot() && l.parent !== fromView.leaf.parent);
				leaf = other ?? workspace.createLeafBySplit(fromView.leaf, 'vertical');
			}
			await leaf.openFile(file, { active: true, eState });
		}
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const from = view.editor.offsetToPos(entry.position.start.offset);
			const to = view.editor.offsetToPos(entry.position.end.offset);
			if (view.getMode() === 'source') {
				view.editor.setSelection(from, to);
				view.editor.scrollIntoView({ from, to }, true);
			}
		}
	}

	/** Add, change or (with '') remove the comment of a highlight in its note. */
	async setHighlightComment(entry: HighlightEntry, comment: string): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		let failed = false;
		await this.app.vault.process(file, (data) => {
			let start = entry.position.start.offset;
			if (data.slice(start, entry.position.end.offset) !== entry.original) {
				start = data.indexOf(entry.original);
				if (start === -1) {
					failed = true;
					return data;
				}
			}
			const line = data.slice(0, start).split('\n').length - 1;
			return setComment(data.split('\n'), line, comment, entry.color ?? null).join('\n');
		});
		if (failed) new Notice('EPUB++: could not find the link in the note (it may have changed).');
	}

	/** Rewrite the `&color=` parameter (and enclosing callout color) of a highlight's link in its note. */
	async setHighlightColor(entry: HighlightEntry, color: string | null): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		let failed = false;
		await this.app.vault.process(file, (data) => {
			let start = entry.position.start.offset;
			let end = entry.position.end.offset;
			if (data.slice(start, end) !== entry.original) {
				start = data.indexOf(entry.original);
				if (start === -1) {
					failed = true;
					return data;
				}
				end = start + entry.original.length;
			}
			const updated = setLinkColor(entry.original, color);
			const next = data.slice(0, start) + updated + data.slice(end);
			const lineNo = next.slice(0, start).split('\n').length - 1;
			return setCalloutColor(next.split('\n'), lineNo, color).join('\n');
		});
		if (failed) new Notice('EPUB++: could not find the link in the note (it may have changed).');
	}

	// --------------------------------------------------------------------------------------------
	// Copying
	// --------------------------------------------------------------------------------------------

	linkStyle(): 'wiki' | 'markdown' {
		const s = this.settings.linkStyle;
		if (s !== 'auto') return s;
		return (this.app.vault as any).getConfig?.('useMarkdownLinks') ? 'markdown' : 'wiki';
	}

	/** Build a link to a selection. `alternate` swaps the configured link type (CFI ↔ text fragment). */
	buildLink(view: EpubView, info: SelectionInfo, color: string | null, alternate = false): string {
		const useText = (this.settings.linkType === 'text') !== alternate;
		const locator = (useText && info.textFragment()) || info.cfi;
		const alias = renderTemplate(this.settings.aliasTemplate, this.templateVars(view, info, color, ''));
		return this.epubLink(view.file!, locator, alias, this.settings.colorInLinks ? color : null);
	}

	/** A link (wiki or markdown, per settings) to a locator in an EPUB. */
	epubLink(file: TFile, locator: string, alias: string, color: string | null = null, sourcePath?: string): string {
		const subpath = formatLocator(locator, { color: color ?? undefined });
		const from = sourcePath ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.lastMarkdownPath() ?? '';
		const linktext = this.app.metadataCache.fileToLinktext(file, from, false);
		return formatLink(linktext, subpath, alias, this.linkStyle());
	}

	private lastMarkdownPath(): string | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
	}

	/** The selection's text as copied: Markdown converted from the book's HTML, or plain text. */
	selectionText(info: SelectionInfo): string {
		if (!this.settings.copyMarkdown) return info.text;
		try {
			return info.markdown() || info.text;
		} catch (e) {
			console.warn('[epub-pp] markdown conversion failed', e);
			return info.text;
		}
	}

	templateVars(view: EpubView, info: SelectionInfo, color: string | null, link: string): Record<string, string> {
		const md = view.book?.metadata;
		return {
			text: this.selectionText(info),
			link,
			color: color ?? '',
			book: md?.title ?? view.file?.basename ?? '',
			author: md?.creators.join(', ') ?? '',
			chapter: info.tocItem?.label ?? '',
			cfi: info.cfi,
			file: view.file?.basename ?? '',
			path: view.file?.path ?? '',
		};
	}

	/** Resolve a copy action (`text`, `link`, `alt-link`, `format:<id>`) to what it copies. */
	resolveCopyAction(action: CopyAction): CopyTarget | null {
		if (action === 'text' || action === 'link' || action === 'alt-link') return action;
		const id = action.slice('format:'.length);
		return this.settings.copyFormats.find((f) => f.id === id) ?? null;
	}

	/** The clipboard text for a selection (synchronous, so it can run inside a `copy` event). */
	renderCopy(view: EpubView, info: SelectionInfo, what: CopyTarget, color: string | null, comment = ''): string {
		if (what === 'text') return this.selectionText(info);
		const link = this.buildLink(view, info, color, what === 'alt-link');
		return typeof what === 'string' ? link : renderTemplate(what.template, { ...this.templateVars(view, info, color, link), comment });
	}

	/** True when copying with this target first asks for a comment ({{comment}} in the template). */
	asksForComment(what: CopyTarget): boolean {
		return typeof what === 'object' && needsComment(what.template);
	}

	copyLabel(what: CopyTarget): string {
		if (what === 'text') return 'text';
		if (what === 'link') return 'link';
		if (what === 'alt-link') return this.settings.linkType === 'cfi' ? 'text-fragment link' : 'CFI link';
		return what.name.toLowerCase();
	}

	/**
	 * Copy a selection. When the book has an annotation file, it may also (or instead) be inserted
	 * there, depending on the file's mode.
	 */
	async copy(view: EpubView, info: SelectionInfo, what: CopyTarget, color: string | null): Promise<void> {
		let comment = '';
		if (this.asksForComment(what)) {
			const c = await askForComment(this.app, info.text);
			if (c === null) return;
			comment = c;
		}
		const text = this.renderCopy(view, info, what, color, comment);
		const ann = what !== 'text' && view.file ? this.annotations.find(view.file) : null;
		const mode = ann ? this.annotations.mode(ann) : 'copy';
		if (mode !== 'insert') await navigator.clipboard.writeText(text);
		if (ann && mode !== 'copy') await this.addToAnnotationFile(view, ann, info, text, mode === 'both');
		else new Notice(`Copied ${this.copyLabel(what)} to clipboard`);
	}

	async addToAnnotationFile(view: EpubView, ann: TFile, info: SelectionInfo, text: string, copied: boolean): Promise<void> {
		try {
			const p = await this.annotations.insert(view, ann, info, text);
			const where = `${ann.basename}${p.heading ? ` › ${p.heading}` : ''}`;
			new Notice(`${copied ? 'Copied and added' : 'Added'} to ${where}${p.appended ? ' (at the end of the section)' : ''}`);
		} catch (e) {
			console.error('[epub-pp] could not add to annotation file', e);
			new Notice(`EPUB++: could not add to ${ann.basename}: ${(e as Error).message}`);
		}
	}

	/** Open (or reveal) a note, preferring another split than the EPUB's. */
	async openNote(file: TFile, fromView?: EpubView): Promise<void> {
		const { workspace } = this.app;
		const open = workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file?.path === file.path);
		if (open) return void workspace.revealLeaf(open);
		const other = fromView && workspace.getLeavesOfType('markdown').find((l) => l.getRoot() === fromView.leaf.getRoot() && l.parent !== fromView.leaf.parent);
		const leaf = Platform.isPhone || !fromView ? workspace.getLeaf('tab') : (other ?? workspace.createLeafBySplit(fromView.leaf, 'vertical'));
		await leaf.openFile(file, { active: true });
	}

	/** Create (if needed) and open the annotation file of the book in `view`. */
	async openAnnotationFile(view: EpubView): Promise<void> {
		if (!view.file) return;
		const existed = this.annotations.find(view.file);
		try {
			const file = existed ?? (await this.annotations.create(view));
			if (!existed) new Notice(`Created ${file.path}`);
			await this.openNote(file, view);
		} catch (e) {
			new Notice(`EPUB++: ${(e as Error).message}`);
		}
	}

	// --------------------------------------------------------------------------------------------
	// Commands
	// --------------------------------------------------------------------------------------------

	private registerCommands(): void {
		const withView = (fn: (v: EpubView) => void) => (checking: boolean) => {
			const v = this.app.workspace.getActiveViewOfType(EpubView);
			if (!v?.reader) return false;
			if (!checking) fn(v);
			return true;
		};
		this.addCommand({ id: 'toggle-sidebar', name: 'Toggle table of contents / search sidebar', checkCallback: withView((v) => v.toggleSidebar()) });
		this.addCommand({ id: 'search', name: 'Search in EPUB', checkCallback: withView((v) => v.openSearch()) });
		this.addCommand({ id: 'annotation-file', name: 'Open or create annotation file', checkCallback: withView((v) => this.openAnnotationFile(v)) });
		this.addCommand({ id: 'appearance', name: 'Reading appearance', checkCallback: withView((v) => v.toggleAppearance()) });
		this.addCommand({ id: 'font-increase', name: 'Increase font size', checkCallback: withView(() => this.updateReaderSettings({ fontSize: Math.min(48, this.settings.reader.fontSize + 1) })) });
		this.addCommand({ id: 'font-decrease', name: 'Decrease font size', checkCallback: withView(() => this.updateReaderSettings({ fontSize: Math.max(8, this.settings.reader.fontSize - 1) })) });
		this.addCommand({
			id: 'cycle-theme',
			name: 'Cycle theme',
			checkCallback: withView(() => {
				const order = ['auto', 'light', 'sepia', 'dark', 'publisher'] as const;
				const i = order.indexOf(this.settings.reader.theme);
				this.updateReaderSettings({ theme: order[(i + 1) % order.length] });
			}),
		});
		const copyCommand = (id: string, name: string, target: () => CopyTarget | null) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const v = this.app.workspace.getActiveViewOfType(EpubView);
					const sel = v?.reader?.getSelection();
					const what = target();
					if (!v || !sel || !what) return false;
					if (!checking) this.copy(v, sel, what, v.activeColor);
					return true;
				},
			});
		copyCommand('copy-text', 'Copy selection as text', () => 'text');
		copyCommand('copy-link', 'Copy link to selection', () => 'link');
		copyCommand('copy-alt-link', 'Copy alternate link to selection (CFI ↔ text fragment)', () => 'alt-link');
		this.syncFormatCommands = () => {
			const commands = (this.app as any).commands;
			for (const id of this.formatCommandIds) commands?.removeCommand?.(`${this.manifest.id}:${id}`);
			this.formatCommandIds = [];
			for (const fmt of this.settings.copyFormats) {
				const id = `copy-format-${fmt.id}`;
				copyCommand(id, `Copy selection as ${fmt.name.toLowerCase()}`, () => this.settings.copyFormats.find((f) => f.id === fmt.id) ?? null);
				this.formatCommandIds.push(id);
			}
		};
		this.syncFormatCommands();
	}

	/** Re-register the per-format copy commands (after formats are added, renamed or removed). Hotkeys are kept by id. */
	syncFormatCommands: () => void = () => {};
	private formatCommandIds: string[] = [];

	// --------------------------------------------------------------------------------------------
	// Backlinks pane integration
	// --------------------------------------------------------------------------------------------

	/**
	 * Hovering a match in Obsidian's Backlinks pane emphasizes the corresponding highlight in the
	 * EPUB (like PDF++). Best-effort: matches by source file name and link text.
	 */
	private registerBacklinkHover(): void {
		let lastIds = '';
		this.registerDomEvent(document, 'mouseover', (e) => {
			const target = e.target as HTMLElement | null;
			const match = target?.closest?.('.workspace-leaf-content[data-type="backlink"] .search-result-file-match, .embedded-backlinks .search-result-file-match');
			const view = this.app.workspace.getActiveViewOfType(EpubView) ?? this.epubViews()[0];
			if (!view?.reader || !view.file) return;
			if (!match) {
				if (lastIds) view.reader.setHoveredHighlights([]);
				lastIds = '';
				return;
			}
			const result = match.closest('.search-result');
			const fileEl = result?.querySelector('.search-result-file-title .tree-item-inner') ?? result?.querySelector('.search-result-file-title');
			const basename = (fileEl?.textContent ?? '').trim();
			const text = match.textContent ?? '';
			const entries = this.index.get(view.file.path).filter((en) => en.sourcePath.split('/').pop()?.replace(/\.md$/, '') === basename);
			// Match rows show the raw markdown line, so the link source identifies the highlight.
			let hits = entries.filter((en) => text.includes(en.original.slice(0, 48)));
			if (!hits.length) hits = entries.filter((en) => en.displayText && text.includes(en.displayText));
			const ids = hits.map((h) => h.id);
			if (ids.join('|') !== lastIds) {
				lastIds = ids.join('|');
				view.reader.setHoveredHighlights(ids);
				const r = ids.length ? view.reader.highlightRange(ids[0]) : null;
				if (r) view.reader.scrollToRange(r, { position: 'center' });
			}
		});
	}
}

function toRgb(color: string): string | null {
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = '#000';
	ctx.fillStyle = color;
	const v = ctx.fillStyle as string;
	const m = /^#([0-9a-f]{6})$/i.exec(v);
	if (m) {
		const n = parseInt(m[1], 16);
		return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
	}
	const r = /rgba?\(([^)]+)\)/.exec(v);
	return r ? r[1].split(',').slice(0, 3).join(',') : null;
}

export type { HighlightEntry };
