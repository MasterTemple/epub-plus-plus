import { formatLocator, type ReaderSettings, type SelectionInfo } from '@epub-pp/core';
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
import { formatLink, renderTemplate, setCalloutColor, setLinkColor } from './link-utils';
import { DEFAULT_SETTINGS, type CopyFormat, type EppSettings, type OpenTarget } from './settings';
import { EppSettingTab } from './setting-tab';
import { EpubView, VIEW_TYPE_EPUB } from './view';

import { HOVER_SOURCE } from './constants';

export default class EpubPlusPlus extends Plugin {
	declare settings: EppSettings;
	index!: HighlightIndex;
	private calloutStyle: HTMLStyleElement | null = null;
	private savePositionsTimer = 0;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.index = new HighlightIndex(this.app);

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubView(leaf, this));
		this.registerExtensions(['epub'], VIEW_TYPE_EPUB);
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'EPUB++ highlights', defaultMod: true });
		this.addSettingTab(new EppSettingTab(this.app, this));
		this.patchLinkOpening();
		this.registerIndexEvents();
		this.registerCommands();
		this.updateCalloutStyles();
		this.registerBacklinkHover();
	}

	override onunload(): void {
		this.calloutStyle?.remove();
	}

	// --------------------------------------------------------------------------------------------
	// Settings
	// --------------------------------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...data, reader: { ...DEFAULT_SETTINGS.reader, ...(data.reader ?? {}) } };
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
		const file = view.file!;
		const useText = (this.settings.linkType === 'text') !== alternate;
		const locator = (useText && info.textFragment()) || info.cfi;
		const subpath = formatLocator(locator, { color: this.settings.colorInLinks && color ? color : undefined });
		const sourcePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.lastMarkdownPath() ?? '';
		const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, false);
		const alias = renderTemplate(this.settings.aliasTemplate, this.templateVars(view, info, color, ''));
		return formatLink(linktext, subpath, alias, this.linkStyle());
	}

	private lastMarkdownPath(): string | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
	}

	templateVars(view: EpubView, info: SelectionInfo, color: string | null, link: string): Record<string, string> {
		const md = view.book?.metadata;
		return {
			text: info.text,
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

	async copy(view: EpubView, info: SelectionInfo, what: CopyFormat | 'link' | 'alt-link' | 'text', color: string | null): Promise<void> {
		let text: string;
		if (what === 'text') text = info.text;
		else {
			const link = this.buildLink(view, info, color, what === 'alt-link');
			text = typeof what === 'string' ? link : renderTemplate(what.template, this.templateVars(view, info, color, link));
		}
		await navigator.clipboard.writeText(text);
		new Notice(`Copied ${typeof what === 'string' ? (what === 'text' ? 'text' : 'link') : what.name.toLowerCase()} to clipboard`);
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
		this.addCommand({
			id: 'copy-link',
			name: 'Copy link to selection',
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(EpubView);
				const sel = v?.reader?.getSelection();
				if (!v || !sel) return false;
				if (!checking) this.copy(v, sel, 'link', v.activeColor);
				return true;
			},
		});
		for (const [i] of this.settings.copyFormats.entries()) {
			this.addCommand({
				id: `copy-format-${i + 1}`,
				name: `Copy selection with format #${i + 1}`,
				checkCallback: (checking) => {
					const v = this.app.workspace.getActiveViewOfType(EpubView);
					const sel = v?.reader?.getSelection();
					const fmt = this.settings.copyFormats[i];
					if (!v || !sel || !fmt) return false;
					if (!checking) this.copy(v, sel, fmt, v.activeColor);
					return true;
				},
			});
		}
	}

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
