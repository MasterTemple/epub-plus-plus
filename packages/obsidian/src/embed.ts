import { EpubReader, cfiEnd, cfiStart, parseLocator, splitIndirection, tryParseCfi, type EpubBook, type ParsedLocator } from '@epub-pp/core';
import { Component, setIcon, type App, type TFile } from 'obsidian';
import type EpubPlusPlus from './main';

/** What Obsidian passes to an embed creator (private API, mirrors the built-in PDF/image embeds). */
interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext?: string;
	sourcePath?: string;
}

/**
 * Register EPUBs with Obsidian's (private) embed registry. This powers both `![[book.epub#…]]`
 * embeds and page previews when hovering `[[book.epub#…]]` links. Returns an unregister function.
 */
export function registerEpubEmbeds(plugin: EpubPlusPlus): (() => void) | null {
	const registry = (plugin.app as any).embedRegistry;
	if (!registry?.registerExtension) return null;
	if (registry.isExtensionRegistered?.('epub')) registry.unregisterExtension('epub');
	registry.registerExtension('epub', (ctx: EmbedContext, file: TFile, subpath?: string) => new EpubEmbed(plugin, ctx, file, subpath ?? ''));
	return () => registry.unregisterExtension?.('epub');
}

/** A small reader showing the linked passage (highlighted), scrolled into view. */
class EpubEmbed extends Component {
	private readonly containerEl: HTMLElement;
	private reader: EpubReader | null = null;
	private unloaded = false;

	constructor(
		private plugin: EpubPlusPlus,
		ctx: EmbedContext,
		private file: TFile,
		private subpath: string,
	) {
		super();
		this.containerEl = ctx.containerEl;
	}

	async loadFile(): Promise<void> {
		const { plugin, file } = this;
		const s = plugin.settings;
		const el = this.containerEl;
		el.empty();
		el.addClass('epp-embed');

		const header = el.createDiv('epp-embed-header');
		const icon = header.createDiv('epp-embed-icon');
		setIcon(icon, 'book-open');
		const title = header.createDiv({ cls: 'epp-embed-title', text: file.basename });
		const open = header.createDiv({ cls: 'clickable-icon epp-embed-open', attr: { 'aria-label': 'Open in EPUB++' } });
		setIcon(open, 'arrow-up-right');
		header.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			plugin.openEpub(file, this.subpath, e.ctrlKey || e.metaKey ? 'tab' : false);
		});
		this.title = title;
		this.host = el.createDiv('epp-embed-host');
		this.host.style.height = `${s.previewHeight}px`;
		await this.renderAt(this.subpath, true);
	}

	private title!: HTMLElement;
	private host!: HTMLElement;

	/** (Re)render the preview around a locator. `highlight`: draw the linked passage. */
	private async renderAt(subpath: string, highlight: boolean): Promise<void> {
		const { plugin, file } = this;
		const s = plugin.settings;
		try {
			const book = await plugin.getBook(file);
			if (this.unloaded) return;
			const loc = parseLocator(subpath);
			const locator = loc.cfi ?? loc.textFragment ?? loc.href;
			this.reader?.destroy();
			const reader = new EpubReader(this.host, book, {
				settings: { ...s.reader, width: 0, margin: 16 },
				palette: plugin.paletteRecord(),
				defaultColor: s.defaultColor,
				highlightOpacity: s.highlightOpacity,
				spineItems: spineItemsFor(book, loc),
				onInternalLink: (href, e) => this.onLink(href, e),
			});
			this.reader = reader;
			await reader.render();
			if (this.unloaded) return;
			let chapter = '';
			if (locator) {
				const range = reader.resolve(locator);
				if (range && highlight && (loc.cfi || loc.textFragment)) {
					const color = loc.params.color ?? (s.noColor === 'none' ? null : s.defaultColor);
					reader.setHighlights(color ? [{ id: 'target', locator, color }] : []);
				}
				if (range) {
					reader.scrollToRange(range, { position: range.collapsed || !highlight ? 'top' : 'center' });
					chapter = reader.tocItemAt(range)?.label ?? '';
				} else chapter = 'location not found';
			}
			this.title.setText([book.metadata.title, chapter].filter(Boolean).join(' · '));
		} catch (e) {
			console.error('[epub-pp] preview failed', e);
			this.host.empty();
			this.host.createDiv({ cls: 'epp-error', text: `Could not preview this EPUB: ${(e as Error).message}` });
		}
	}

	/** Links inside the book: jump within the preview, or open the EPUB tab (setting / Ctrl-click). */
	private onLink(href: string, e: MouseEvent): boolean {
		e.preventDefault();
		e.stopPropagation();
		const mod = e.ctrlKey || e.metaKey;
		if (mod || this.plugin.settings.previewLinks === 'tab') {
			void this.plugin.openEpub(this.file, href, mod ? 'tab' : false);
			return true;
		}
		// Rendered already (same chapter)? Let the reader scroll there.
		if (this.reader?.resolve(href)) return false;
		void this.renderAt(href, false);
		return true;
	}

	override onunload(): void {
		this.unloaded = true;
		this.reader?.destroy();
		this.reader = null;
	}
}

/** Spine items worth rendering for a locator: just the target's (fast), or everything for text fragments. */
function spineItemsFor(book: EpubBook, loc: ParsedLocator): number[] | undefined {
	if (loc.cfi) {
		const cfi = tryParseCfi(loc.cfi);
		if (!cfi) return undefined;
		const a = book.spineItemForCfiSteps(splitIndirection(cfiStart(cfi).steps).outer)?.index;
		const b = book.spineItemForCfiSteps(splitIndirection(cfiEnd(cfi).steps).outer)?.index ?? a;
		if (a === undefined || b === undefined) return undefined;
		return range(Math.min(a, b), Math.max(a, b));
	}
	if (loc.href) {
		const item = book.spineItemForHref(loc.href) ?? book.spine.find((s) => s.href.endsWith(`/${loc.href!.split('#')[0]}`));
		return item ? [item.index] : undefined;
	}
	if (loc.textFragment) return undefined;
	return range(0, Math.min(2, book.spine.length - 1));
}

function range(a: number, b: number): number[] {
	return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
