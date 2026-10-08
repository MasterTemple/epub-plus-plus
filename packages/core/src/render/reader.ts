import { DocumentReader, type LocatorScheme, type ParsedLocator, type ReaderOptions, type TocItem } from 'file-plus-plus/core';
import type { EpubBook, SpineItem } from '../book/epub';
import { CssProcessor } from '../css/rewrite';
import { cfiEnd, cfiStart, makeRangeCfi, pointToPath, resolvePath as resolveCfiPath, serializeCfi, splitIndirection, tryParseCfi, type CfiPath, type CfiStep } from '../locators/cfi';
import { EPUB_SCHEMES } from '../locators/locator';
import { splitFragment } from '../util/path';
import { buildSection, prepareSection, type PreparedSection } from './content';
import { EPUB_CSS } from './epub-css';

export interface EpubReaderOptions extends ReaderOptions {
	/** Emit CFIs with `[id]` assertions (default false: they contain `[ ]`, which break wikilinks). */
	cfiAssertions?: boolean;
	/** Render only these spine indices (e.g. for a lightweight preview). Default: all. */
	spineItems?: number[];
}

interface EpubSection {
	index: number;
	item: SpineItem;
	wrapper: HTMLElement;
	body: HTMLElement;
	bodyStep: CfiStep;
}

/**
 * Renders a whole EPUB as one continuous document (file-plus-plus `DocumentReader`): each spine item
 * is a section, locators are CFIs (plus text fragments and hrefs), and the publisher's CSS is rewritten
 * to work inside the shadow root.
 */
export class EpubReader extends DocumentReader {
	readonly schemes: LocatorScheme[] = EPUB_SCHEMES;
	private readonly cfiAssertions: boolean;
	private readonly spineFilter: Set<number> | null;
	private fontStyle: HTMLStyleElement | null = null;
	private epubSections = new Map<number, EpubSection>();

	constructor(
		host: HTMLElement,
		readonly book: EpubBook,
		opts: EpubReaderOptions = {},
	) {
		super(host, opts);
		this.cfiAssertions = opts.cfiAssertions ?? false;
		this.spineFilter = opts.spineItems ? new Set(opts.spineItems) : null;
		this.content.lang = book.metadata.language || '';
	}

	protected override extraCss(): string {
		return EPUB_CSS;
	}

	get toc(): TocItem[] {
		return this.book.toc;
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------------------------

	/** Parse every spine item, rewrite CSS and mount the joined document. */
	protected async renderContent(): Promise<void> {
		const prefix = `epp${this.id}`;
		const css = new CssProcessor({
			resolveUrl: (p) => this.book.blobUrl(p),
			loadText: (p) => (this.book.has(p) ? this.book.text(p) : null),
			fontPrefix: prefix,
		});

		const prepared: PreparedSection[] = [];
		let last = performance.now();
		for (const item of this.book.spine) {
			if (this.spineFilter && !this.spineFilter.has(item.index)) continue;
			try {
				prepared.push(prepareSection(this.book, item));
			} catch (e) {
				console.error(`[epub-pp] failed to load ${item.href}`, e);
			}
			if (performance.now() - last > 30) {
				await yieldToBrowser();
				if (this.destroyed) return;
				last = performance.now();
			}
		}

		// Register each distinct stylesheet once; sheets not used by every chapter get scoped.
		const sheetIds = new Map<string, string>();
		const usage = new Map<string, number>();
		for (const p of prepared) {
			for (const s of p.sheets) {
				if (!sheetIds.has(s.key)) {
					const id = `s${sheetIds.size + 1}`;
					sheetIds.set(s.key, id);
					try {
						css.addSheet(id, s.text, s.path);
					} catch (e) {
						console.warn('[epub-pp] could not parse stylesheet', s.path, e);
					}
				}
				const id = sheetIds.get(s.key)!;
				usage.set(id, (usage.get(id) ?? 0) + 1);
			}
		}

		const frag = this.doc.createDocumentFragment();
		for (const p of prepared) {
			const ids = [...new Set(p.sheets.map((s) => sheetIds.get(s.key)!))];
			const { wrapper, body } = buildSection(this.doc, this.book, p, css, ids);
			const sec: EpubSection = { index: p.item.index, item: p.item, wrapper, body, bodyStep: p.bodyStep };
			this.addSection(sec);
			this.epubSections.set(sec.index, sec);
			frag.appendChild(wrapper);
			if (performance.now() - last > 30) {
				await yieldToBrowser();
				if (this.destroyed) return;
				last = performance.now();
			}
		}

		const scoped = new Set([...usage].filter(([, n]) => n < prepared.length).map(([id]) => id));
		const { css: publisherCss, fontFaces } = css.build(scoped);
		const pubStyle = this.doc.createElement('style');
		pubStyle.textContent = `@layer document {\n${publisherCss}\n}`;
		this.shadow.insertBefore(pubStyle, this.highlightStyle);
		if (fontFaces) {
			// @font-face is ignored inside shadow roots, so fonts are registered on the document.
			this.fontStyle = this.doc.createElement('style');
			this.fontStyle.setAttribute('data-epp-fonts', prefix);
			this.fontStyle.textContent = fontFaces;
			this.doc.head.appendChild(this.fontStyle);
		}

		this.content.appendChild(frag);
	}

	// ---------------------------------------------------------------------------------------------
	// Locators
	// ---------------------------------------------------------------------------------------------

	protected resolveLocator(loc: ParsedLocator): Range | null {
		if (loc.scheme === 'cfi') return this.resolveCfi(loc.locator!);
		if (loc.scheme === 'href') return this.resolveHref(loc.locator!);
		return null;
	}

	resolveCfi(cfiString: string): Range | null {
		const cfi = tryParseCfi(cfiString);
		if (!cfi) return null;
		const start = this.resolveCfiPath(cfiStart(cfi), false);
		if (!start) return null;
		const range = this.doc.createRange();
		range.setStart(start.container, start.offset);
		const end = cfi.range ? this.resolveCfiPath(cfiEnd(cfi), true) : null;
		if (end) range.setEnd(end.container, end.offset);
		else if (start.element && !cfi.range) range.selectNode(start.element);
		else range.collapse(true);
		return range;
	}

	private resolveCfiPath(path: CfiPath, isEnd: boolean): { container: Node; offset: number; element?: Element } | null {
		const { outer, inner } = splitIndirection(path.steps);
		const item = this.book.spineItemForCfiSteps(outer);
		const sec = item && this.epubSections.get(item.index);
		if (!sec) return null;
		if (inner.length === 0 || inner[0].index !== sec.bodyStep.index) {
			return isEnd ? { container: sec.body, offset: sec.body.childNodes.length } : { container: sec.body, offset: 0 };
		}
		const p = resolveCfiPath(sec.body, inner.slice(1), path.offset);
		if (!p) return null;
		if (isEnd && p.element) {
			return { container: p.container, offset: p.offset + 1, element: p.element };
		}
		return p;
	}

	private resolveHref(href: string): Range | null {
		const { path, fragment } = splitFragment(href);
		let sec: EpubSection | undefined;
		if (path) {
			const all = [...this.epubSections.values()];
			sec = all.find((s) => s.item.href === path) ?? all.find((s) => s.item.href.endsWith(`/${path}`) || path.endsWith(`/${s.item.href}`));
			if (!sec) return null;
		}
		const scope: ParentNode = sec?.wrapper ?? this.content;
		let target: Element | null = null;
		if (fragment) {
			let id = fragment;
			try {
				id = decodeURIComponent(fragment);
			} catch {
				/* raw */
			}
			target = scope.querySelector(`[id="${CSS.escape(id)}"]`) ?? scope.querySelector(`a[name="${CSS.escape(id)}"]`);
		}
		const range = this.doc.createRange();
		if (target) range.selectNode(target);
		else if (sec) {
			range.setStart(sec.body, 0);
			range.collapse(true);
		} else return null;
		return range;
	}

	locatorFromRange(range: Range): string | null {
		return this.cfiFromRange(range);
	}

	/** Generate a CFI for a range (or collapsed point). */
	cfiFromRange(range: Range): string | null {
		const r = this.clampRange(range);
		if (!r) return null;
		const start = this.pointToCfiPath(r.startContainer, r.startOffset);
		const end = this.pointToCfiPath(r.endContainer, r.endOffset);
		if (!start || !end) return null;
		const cfi = r.collapsed ? { range: false as const, path: start } : makeRangeCfi(start, end);
		return serializeCfi(cfi, { assertions: this.cfiAssertions });
	}

	private pointToCfiPath(container: Node, offset: number): CfiPath | null {
		const s = this.sectionOf(container);
		const sec = s && this.epubSections.get(s.index);
		if (!sec) return null;
		const inner = pointToPath(sec.body, container, offset);
		const steps: CfiStep[] = [...sec.item.cfiSteps.map((st) => ({ ...st })), { ...sec.bodyStep, indirect: true }, ...inner.steps];
		return { steps, offset: inner.offset };
	}

	/** The spine index of the section a node is in, or -1. */
	spineIndexOf(node: Node): number {
		return this.sectionIndexOf(node);
	}

	override destroy(): void {
		this.fontStyle?.remove();
		super.destroy();
	}
}

function yieldToBrowser(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}
