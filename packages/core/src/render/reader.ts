import type { EpubBook, SpineItem } from '../book/epub';
import { flattenToc, type TocItem } from '../book/toc';
import { CssProcessor } from '../css/rewrite';
import {
	cfiEnd,
	cfiStart,
	makeRangeCfi,
	pointToPath,
	resolvePath as resolveCfiPath,
	serializeCfi,
	splitIndirection,
	tryParseCfi,
	type CfiPath,
	type CfiStep,
} from '../locators/cfi';
import { parseLocator } from '../locators/locator';
import { createTextFragment, findTextFragment, parseTextFragment, serializeTextFragment } from '../locators/text-fragment';
import { searchIndex, type SearchMatch, type SearchOptions } from '../search/search';
import { TextIndex } from '../search/text-index';
import { Emitter } from '../util/emitter';
import { splitFragment } from '../util/path';
import { buildSection, prepareSection, type PreparedSection } from './content';
import { rangeToMarkdown } from './markdown';
import { BASE_CSS, DEFAULT_SETTINGS, settingsToVars, type ReaderSettings } from './settings';

export interface HighlightSpec<T = unknown> {
	id: string;
	/** `epubcfi(...)`, `:~:text=...` or an href. */
	locator: string;
	/** Palette name or any CSS color. */
	color?: string;
	data?: T;
}

/** How an annotation layer is drawn and ordered (see `setLayer`). */
export interface AnnotationLayerOptions {
	/**
	 * CSS declarations for `::highlight()`, given an annotation's resolved color (only `color`,
	 * `background-color`, `text-decoration*`, `text-shadow` and `-webkit-text-*` apply there).
	 * Default: a background like highlights have.
	 */
	style?: (color: string) => string;
	/** Paint order; highlights are 0. Default -1 (below highlights). */
	priority?: number;
	/** Keep the layer (for `describeLayer`) without drawing it or reporting it under the pointer. */
	hidden?: boolean;
}

/** An annotation of a layer under the pointer. */
export interface LayerHit<T = unknown> {
	layer: string;
	spec: HighlightSpec<T>;
}

interface Layer {
	key: number;
	opts: AnnotationLayerOptions;
	items: { spec: HighlightSpec; range: StaticRange | null }[];
	/** Element → indices of items starting, ending or contained in it (for hit-testing). */
	buckets: Map<Element, number[]>;
	resolved: boolean;
	names: string[];
}

export interface SelectionInfo {
	range: Range;
	text: string;
	cfi: string;
	spineIndex: number;
	tocItem: TocItem | null;
	/** Lazily computed text fragment directive (`:~:text=...`). */
	textFragment(): string | null;
	/** The selection converted to Markdown (emphasis, lists, paragraphs…), computed lazily. */
	markdown(): string;
}

export interface Location {
	cfi: string;
	spineIndex: number;
	tocItem: TocItem | null;
	/** 0..1 scroll progress through the whole book. */
	progress: number;
}

export interface SearchResult extends SearchMatch {
	/** Live range (created on demand; prefer `staticRange()` for painting many results). */
	range(): Range;
	staticRange(): StaticRange;
	cfi(): string;
	tocItem(): TocItem | null;
}

type ReaderEvents = {
	ready: [];
	relocated: [Location];
	'highlight-click': [MouseEvent, HighlightSpec[]];
	/** Fired when the highlights under the pointer change (empty array: left all highlights). */
	'highlight-hover': [MouseEvent, HighlightSpec[]];
	contextmenu: [MouseEvent, { selection: SelectionInfo | null; highlights: HighlightSpec[]; annotations: LayerHit[] }];
	/** A click on annotations of layers (and on no highlight). */
	'annotation-click': [MouseEvent, LayerHit[]];
	/** Fired when the annotations under the pointer change (empty array: left them). */
	'annotation-hover': [MouseEvent, LayerHit[]];
	'external-link': [MouseEvent, string];
	selectionchange: [SelectionInfo | null];
};

export interface ReaderOptions {
	settings?: Partial<ReaderSettings>;
	/** Highlight palette: name → CSS color. */
	palette?: Record<string, string>;
	defaultColor?: string;
	/** Emit CFIs with `[id]` assertions (default false: they contain `[ ]`, which break wikilinks). */
	cfiAssertions?: boolean;
	/** Opacity (0..1) of highlight backgrounds. */
	highlightOpacity?: number;
	/** Default look of the temporary highlight shown after jumping to a passage. */
	flash?: FlashOptions;
	/** Render only these spine indices (e.g. for a lightweight preview). Default: all. */
	spineItems?: number[];
	/** Called for clicks on links inside the book; return true to handle it yourself (default: goTo). */
	onInternalLink?: (href: string, event: MouseEvent) => boolean;
}

export interface FlashOptions {
	/** Total time on screen in ms, including the fade-out. */
	duration?: number;
	/** Fade-out time in ms at the end of `duration`. */
	fade?: number;
	/** Any CSS color. */
	color?: string;
	/** Peak opacity 0..1. */
	opacity?: number;
}

interface RenderedSection {
	item: SpineItem;
	wrapper: HTMLElement;
	body: HTMLElement;
	bodyStep: CfiStep;
}

let instanceCounter = 0;

/**
 * Renders a whole EPUB as one continuous document inside a shadow root (no iframes) and provides
 * navigation, locators (CFI / Text Fragments), highlights and search.
 */
export class EpubReader extends Emitter<ReaderEvents> {
	readonly shadow: ShadowRoot;
	readonly scroller: HTMLElement;
	/** The host's document/window (may be an Obsidian popout window, not the global one). */
	readonly doc: Document;
	readonly win: Window & typeof globalThis;
	readonly content: HTMLElement;
	private readonly id = ++instanceCounter;
	private settings: ReaderSettings;
	private palette: Record<string, string>;
	private defaultColor: string;
	private readonly cfiAssertions: boolean;
	private readonly highlightOpacity: number;
	private sections: RenderedSection[] = [];
	private sectionBySpine = new Map<number, RenderedSection>();
	private fontStyle: HTMLStyleElement | null = null;
	private highlightStyle: HTMLStyleElement;
	private _index: TextIndex | null = null;
	private highlights: { spec: HighlightSpec; range: Range | null }[] = [];
	private rangeCache = new Map<string, Range | null>();
	private highlightNames = new Set<string>();
	private tocTargets: { item: TocItem; node: Node }[] | null = null;
	private cleanup: (() => void)[] = [];
	private rendered = false;
	private destroyed = false;
	private relocateTimer = 0;
	private flashTimer = 0;
	private flashRaf = 0;
	private flashStyle: HTMLStyleElement;
	private flashDefaults: Required<FlashOptions>;
	private readonly spineFilter: Set<number> | null;
	private readonly onInternalLink?: (href: string, event: MouseEvent) => boolean;
	/** Reading position to restore when the host is re-attached or resized (DOM moves reset scrollTop). */
	private anchor: Range | null = null;
	private scratchRange: Range | null = null;
	private anchorPosition: 'top' | 'center' = 'top';
	private hostSize = { w: 0, h: 0 };
	private lastHover: string = '';
	private lastLayerHover: string = '';
	private layers = new Map<string, Layer>();
	private layerCounter = 0;
	private layerStyle: HTMLStyleElement;
	private hitRange: Range | null = null;

	constructor(
		readonly host: HTMLElement,
		readonly book: EpubBook,
		opts: ReaderOptions = {},
	) {
		super();
		this.doc = host.ownerDocument;
		this.win = (this.doc.defaultView ?? window) as Window & typeof globalThis;
		this.settings = { ...DEFAULT_SETTINGS, ...opts.settings };
		this.palette = opts.palette ?? { yellow: '#ffd000', red: '#ff5f5f', green: '#5fd068', blue: '#5fa8ff', purple: '#b07cff' };
		this.defaultColor = opts.defaultColor ?? Object.keys(this.palette)[0] ?? 'yellow';
		this.cfiAssertions = opts.cfiAssertions ?? false;
		this.highlightOpacity = opts.highlightOpacity ?? 0.4;
		this.flashDefaults = { duration: 1600, fade: 600, color: '#ffb000', opacity: 0.6, ...opts.flash };
		this.spineFilter = opts.spineItems ? new Set(opts.spineItems) : null;
		this.onInternalLink = opts.onInternalLink;

		this.shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
		this.shadow.replaceChildren();
		const base = this.doc.createElement('style');
		base.textContent = BASE_CSS;
		this.highlightStyle = this.doc.createElement('style');
		this.scroller = this.doc.createElement('div');
		this.scroller.className = 'epp-scroller';
		this.scroller.tabIndex = 0;
		this.content = this.doc.createElement('div');
		this.content.className = 'epp-content';
		this.content.lang = book.metadata.language || '';
		this.scroller.appendChild(this.content);
		this.flashStyle = this.doc.createElement('style');
		this.layerStyle = this.doc.createElement('style');
		this.shadow.append(base, this.highlightStyle, this.layerStyle, this.flashStyle, this.scroller);
		this.applySettings();
		this.bindEvents();
	}

	private get registry(): HighlightRegistry | undefined {
		return (this.win as any).CSS?.highlights;
	}

	private get HighlightCtor(): typeof Highlight | undefined {
		return (this.win as any).Highlight;
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------------------------

	/** Parse every spine item, rewrite CSS and mount the joined this.doc. */
	async render(): Promise<void> {
		if (this.rendered) return;
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
			const sec: RenderedSection = { item: p.item, wrapper, body, bodyStep: p.bodyStep };
			this.sections.push(sec);
			this.sectionBySpine.set(p.item.index, sec);
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
		pubStyle.textContent = `@layer publisher {\n${publisherCss}\n}`;
		this.shadow.insertBefore(pubStyle, this.highlightStyle);
		if (fontFaces) {
			// @font-face is ignored inside shadow roots, so fonts are registered on the this.doc.
			this.fontStyle = this.doc.createElement('style');
			this.fontStyle.setAttribute('data-epp-fonts', prefix);
			this.fontStyle.textContent = fontFaces;
			this.doc.head.appendChild(this.fontStyle);
		}

		this.content.appendChild(frag);
		this.rendered = true;
		this.updateHighlightStyles();
		this.paintLayers();
		this.emit('ready');
	}

	get isRendered(): boolean {
		return this.rendered;
	}

	// ---------------------------------------------------------------------------------------------
	// Settings
	// ---------------------------------------------------------------------------------------------

	getSettings(): ReaderSettings {
		return { ...this.settings };
	}

	/** Apply new settings live (CSS variables only; no re-render). Keeps the reading position. */
	updateSettings(patch: Partial<ReaderSettings>): void {
		const loc = this.rendered ? (this.currentAnchor() ?? this.anchor) : null;
		this.settings = { ...this.settings, ...patch };
		this.applySettings();
		if (loc) this.win.requestAnimationFrame(() => this.scrollToRange(loc, { flash: false, position: 'top' }));
	}

	private applySettings(): void {
		const hostDark = this.doc.body?.classList.contains('theme-dark') ?? this.win.matchMedia?.('(prefers-color-scheme: dark)').matches;
		const vars = settingsToVars(this.settings, !!hostDark);
		for (const [k, v] of Object.entries(vars)) {
			if (v === null) this.host.style.removeProperty(k);
			else this.host.style.setProperty(k, v);
		}
		this.scroller.classList.toggle('epp-themed', this.settings.theme !== 'publisher');
	}

	setPalette(palette: Record<string, string>, defaultColor?: string): void {
		this.palette = palette;
		if (defaultColor) this.defaultColor = defaultColor;
		this.refreshHighlights();
		this.paintLayers();
	}

	// ---------------------------------------------------------------------------------------------
	// Locators
	// ---------------------------------------------------------------------------------------------

	get textIndex(): TextIndex {
		if (!this._index) this._index = new TextIndex(this.content);
		return this._index;
	}

	/** Resolve any supported locator (`epubcfi(...)`, `:~:text=...`, href, `#fragment`) to a DOM range. */
	resolve(locator: string | null | undefined): Range | null {
		if (!this.rendered || !locator) return null;
		const loc = parseLocator(locator);
		if (loc.cfi) return this.resolveCfi(loc.cfi);
		if (loc.textFragment) {
			const tf = parseTextFragment(loc.textFragment);
			const r = tf && findTextFragment(this.textIndex, tf);
			return r ? this.textIndex.toRange(r[0], r[1]) : null;
		}
		if (loc.href) return this.resolveHref(loc.href);
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
		const sec = item && this.sectionBySpine.get(item.index);
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
		let sec: RenderedSection | undefined;
		if (path) {
			sec = this.sections.find((s) => s.item.href === path) ?? this.sections.find((s) => s.item.href.endsWith(`/${path}`) || path.endsWith(`/${s.item.href}`));
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
		const sec = this.sectionOf(container);
		if (!sec) return null;
		const inner = pointToPath(sec.body, container, offset);
		const steps: CfiStep[] = [
			...sec.item.cfiSteps.map((s) => ({ ...s })),
			{ ...sec.bodyStep, indirect: true },
			...inner.steps,
		];
		return { steps, offset: inner.offset };
	}

	textFragmentFromRange(range: Range): string | null {
		const [s, e] = this.textIndex.rangeToOffsets(range);
		const tf = createTextFragment(this.textIndex, s, e);
		return tf ? serializeTextFragment(tf) : null;
	}

	private sectionOf(node: Node): RenderedSection | null {
		const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('.epp-html');
		if (!el) return null;
		return this.sectionBySpine.get(Number(el.getAttribute('data-epp-spine'))) ?? null;
	}

	/** Ensure both ends of a range are inside section bodies. */
	private clampRange(range: Range): Range | null {
		const r = range.cloneRange();
		const startSec = this.sectionOf(r.startContainer);
		if (!startSec || !startSec.body.contains(r.startContainer)) {
			const next = this.sections.find((s) => r.comparePoint(s.body, 0) >= 0);
			if (!next) return null;
			r.setStart(next.body, 0);
		}
		const endSec = this.sectionOf(r.endContainer);
		if (!endSec || !endSec.body.contains(r.endContainer)) {
			const prev = [...this.sections].reverse().find((s) => r.comparePoint(s.body, s.body.childNodes.length) <= 0);
			if (!prev) return null;
			r.setEnd(prev.body, prev.body.childNodes.length);
		}
		return r;
	}

	spineIndexOf(node: Node): number {
		return this.sectionOf(node)?.item.index ?? -1;
	}

	// ---------------------------------------------------------------------------------------------
	// Navigation
	// ---------------------------------------------------------------------------------------------

	/**
	 * Jump to a locator or TOC item. Returns false when it could not be resolved.
	 * `flash`: briefly highlight the target (default: only for CFI / text-fragment ranges).
	 */
	goTo(target: string | TocItem, opts: { flash?: boolean | FlashOptions } = {}): boolean {
		const range = typeof target === 'string' ? this.resolve(target) : target.href ? this.resolveHref(target.href) : null;
		if (!range) return false;
		const isPoint = range.collapsed || typeof target !== 'string' || !/epubcfi|text=/.test(target);
		this.scrollToRange(range, { flash: opts.flash ?? !isPoint, position: isPoint ? 'top' : 'center' });
		return true;
	}

	scrollToRange(range: Range, opts: { flash?: boolean | FlashOptions; position?: 'top' | 'center' } = {}): void {
		const position = opts.position ?? 'center';
		this.anchor = range;
		this.anchorPosition = position;
		const doScroll = () => {
			const rect = rangeRect(range);
			if (!rect) return;
			const box = this.scroller.getBoundingClientRect();
			const offset = position === 'top' ? 16 : box.height * 0.3;
			this.scroller.scrollTop += rect.top - box.top - offset;
		};
		doScroll();
		// content-visibility placeholders around the target get laid out after the jump; correct for drift.
		this.win.requestAnimationFrame(() => {
			doScroll();
			this.win.requestAnimationFrame(doScroll);
		});
		if (opts.flash) this.flash(range, typeof opts.flash === 'object' ? opts.flash : {});
	}

	/** Temporarily highlight a range (drawn above regular highlights), fading out at the end. */
	flash(range: Range, opts: FlashOptions = {}): void {
		if (!this.HighlightCtor) return;
		const o = { ...this.flashDefaults, ...opts };
		const name = this.hlName('flash');
		const h = new this.HighlightCtor!(range);
		h.priority = 10;
		this.registry!.set(name, h);
		this.win.clearTimeout(this.flashTimer);
		this.win.cancelAnimationFrame(this.flashRaf);
		const paint = (alpha: number) => {
			this.flashStyle.textContent = `::highlight(${name}) { background-color: color-mix(in srgb, ${o.color} ${Math.round(alpha * 100)}%, transparent); }`;
		};
		paint(o.opacity);
		const fade = Math.min(o.fade, o.duration);
		this.flashTimer = this.win.setTimeout(() => {
			const start = performance.now();
			const step = (now: number) => {
				const t = Math.min(1, (now - start) / Math.max(1, fade));
				paint(o.opacity * (1 - t));
				if (t < 1) this.flashRaf = this.win.requestAnimationFrame(step);
				else {
					this.registry!.delete(name);
					this.flashStyle.textContent = '';
				}
			};
			this.flashRaf = this.win.requestAnimationFrame(step);
		}, Math.max(0, o.duration - fade));
	}

	setFlashDefaults(opts: FlashOptions): void {
		this.flashDefaults = { ...this.flashDefaults, ...opts };
	}

	/** Current reading position (first visible block). */
	getLocation(): Location | null {
		const anchor = this.currentAnchor();
		if (!anchor) return null;
		const cfi = this.cfiFromRange(anchor);
		if (!cfi) return null;
		const sh = this.scroller.scrollHeight - this.scroller.clientHeight;
		return {
			cfi,
			spineIndex: this.spineIndexOf(anchor.startContainer),
			tocItem: this.tocItemAt(anchor),
			progress: sh > 0 ? this.scroller.scrollTop / sh : 0,
		};
	}

	/** A collapsed range at the start of the first block intersecting the top of the viewport. */
	private currentAnchor(): Range | null {
		if (!this.sections.length) return null;
		// Probe just below the 16px gap that scrollToRange(position: 'top') leaves, so restores are stable.
		const top = this.scroller.getBoundingClientRect().top + 18;
		// First section extending below the top edge (sections are separated by margins).
		let sec = this.sections[this.sections.length - 1];
		let lo = 0;
		let hi = this.sections.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.sections[mid].wrapper.getBoundingClientRect().bottom <= top) lo = mid + 1;
			else hi = mid;
		}
		sec = this.sections[lo] ?? sec;
		let parent: Element = sec.body;
		let found: Element | null = null;
		// Descend through blocks: pick the first child whose bottom is below the viewport top.
		for (let depth = 0; depth < 6; depth++) {
			const kids = Array.from(parent.children);
			if (!kids.length) break;
			let lo = 0;
			let hi = kids.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (kids[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
				else hi = mid;
			}
			const k = kids[lo];
			const r = k.getBoundingClientRect();
			found = k;
			if (r.top >= top - 2 || r.height < this.scroller.clientHeight / 2) break;
			parent = k;
		}
		const range = this.doc.createRange();
		if (found) range.setStartBefore(found);
		else range.setStart(sec.body, 0);
		range.collapse(true);
		return range;
	}

	// ---------------------------------------------------------------------------------------------
	// Table of contents
	// ---------------------------------------------------------------------------------------------

	get toc(): TocItem[] {
		return this.book.toc;
	}

	/** Deepest TOC entry at or before the given position. */
	tocItemAt(range: AbstractRange): TocItem | null {
		if (!this.tocTargets) {
			const targets: { item: TocItem; node: Node }[] = [];
			for (const item of flattenToc(this.book.toc)) {
				const r = item.href ? this.resolveHref(item.href) : null;
				if (r) targets.push({ item, node: r.startContainer.childNodes[r.startOffset] ?? r.startContainer });
			}
			// Stable sort keeps parents before children that point at the same node.
			targets.sort((x, y) => (x.node === y.node ? 0 : x.node.compareDocumentPosition(y.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
			this.tocTargets = targets;
		}
		const point = (this.scratchRange ??= this.doc.createRange());
		point.setStart(range.startContainer, range.startOffset);
		point.collapse(true);
		let best: TocItem | null = null;
		for (const t of this.tocTargets) {
			if (point.comparePoint(t.node, 0) <= 0) best = t.item;
			else break;
		}
		return best;
	}

	// ---------------------------------------------------------------------------------------------
	// Selection
	// ---------------------------------------------------------------------------------------------

	getSelectionRange(): Range | null {
		const sel: Selection | null = (this.shadow as any).getSelection?.() ?? this.doc.getSelection();
		if (!sel) return null;
		// Selections inside shadow roots: Chromium has shadowRoot.getSelection(); WebKit/Gecko use
		// getComposedRanges, whose signature changed ({shadowRoots: [...]} vs. spread roots), so try both
		// and fall back to the plain range. Use the first candidate that lies inside the book.
		const candidates: AbstractRange[] = [];
		const getComposed = (sel as any).getComposedRanges as ((...a: unknown[]) => StaticRange[]) | undefined;
		if (getComposed) {
			for (const args of [[{ shadowRoots: [this.shadow] }], [this.shadow]]) {
				try {
					const ranges = getComposed.apply(sel, args);
					if (ranges?.length) {
						candidates.push(ranges[0]);
						break;
					}
				} catch {
					/* other signature */
				}
			}
		}
		if (sel.rangeCount) candidates.push(sel.getRangeAt(0));
		for (const r of candidates) {
			if (r.collapsed || !this.content.contains(r.startContainer) || !this.content.contains(r.endContainer)) continue;
			const range = this.doc.createRange();
			range.setStart(r.startContainer, r.startOffset);
			range.setEnd(r.endContainer, r.endOffset);
			return range;
		}
		return null;
	}

	describeRange(range: Range): SelectionInfo | null {
		const r = this.clampRange(range);
		if (!r) return null;
		const cfi = this.cfiFromRange(r);
		if (!cfi) return null;
		let tf: string | null | undefined;
		let md: string | undefined;
		return {
			range: r,
			text: rangeText(r),
			cfi,
			spineIndex: this.spineIndexOf(r.startContainer),
			tocItem: this.tocItemAt(r),
			textFragment: () => (tf === undefined ? (tf = this.textFragmentFromRange(r)) : tf),
			markdown: () => (md ??= rangeToMarkdown(r)),
		};
	}

	getSelection(): SelectionInfo | null {
		const r = this.getSelectionRange();
		return r ? this.describeRange(r) : null;
	}

	clearSelection(): void {
		((this.shadow as any).getSelection?.() ?? this.doc.getSelection())?.removeAllRanges();
	}

	// ---------------------------------------------------------------------------------------------
	// Highlights
	// ---------------------------------------------------------------------------------------------

	setHighlights(specs: HighlightSpec[]): void {
		this.highlights = specs.map((spec) => ({ spec, range: this.cachedRange(spec.locator) }));
		this.refreshHighlights();
	}

	getHighlights(): HighlightSpec[] {
		return this.highlights.map((h) => h.spec);
	}

	private cachedRange(locator: string): Range | null {
		if (!this.rendered) return null;
		if (!this.rangeCache.has(locator)) this.rangeCache.set(locator, this.resolve(locator));
		return this.rangeCache.get(locator)!;
	}

	private hlName(key: string): string {
		return `epp${this.id}-${key}`;
	}

	private colorKey(color: string | undefined): { key: string; css: string } {
		const name = color && color in this.palette ? color : !color ? this.defaultColor : null;
		if (name) return { key: `c-${name.replace(/[^\w-]/g, '_')}`, css: this.palette[name] ?? this.palette[this.defaultColor] ?? '#ffd000' };
		const valid = typeof CSS !== 'undefined' && CSS.supports?.('color', color!);
		const cssColor = valid ? color! : (this.palette[this.defaultColor] ?? '#ffd000');
		return { key: `x-${hash(cssColor)}`, css: cssColor };
	}

	private refreshHighlights(): void {
		if (!this.rendered || !this.HighlightCtor) return;
		const groups = new Map<string, { css: string; ranges: Range[] }>();
		for (const h of this.highlights) {
			if (!h.range) h.range = this.cachedRange(h.spec.locator);
			if (!h.range) continue;
			const { key, css } = this.colorKey(h.spec.color);
			let g = groups.get(key);
			if (!g) groups.set(key, (g = { css, ranges: [] }));
			g.ranges.push(h.range);
		}
		for (const name of this.highlightNames) this.registry!.delete(name);
		this.highlightNames.clear();
		for (const [key, g] of groups) {
			const name = this.hlName(key);
			this.registry!.set(name, new this.HighlightCtor!(...g.ranges));
			this.highlightNames.add(name);
		}
		this.updateHighlightStyles(groups);
	}

	private updateHighlightStyles(groups?: Map<string, { css: string }>): void {
		const pct = Math.round(this.highlightOpacity * 100);
		const rules = [
			`::highlight(${this.hlName('search')}) { background-color: rgba(255, 170, 0, 0.35); }`,
			`::highlight(${this.hlName('search-current')}) { background-color: rgba(255, 120, 0, 0.8); color: black; }`,
			`::highlight(${this.hlName('pending')}) { background-color: var(--text-selection, Highlight); }`,
			`::highlight(${this.hlName('hover')}) { text-decoration: underline 2px; text-decoration-color: currentColor; }`,
		];
		for (const [key, g] of groups ?? []) {
			rules.push(`::highlight(${this.hlName(key)}) { background-color: color-mix(in srgb, ${g.css} ${pct}%, transparent); }`);
		}
		this.highlightStyle.textContent = rules.join('\n');
	}

	/**
	 * Paint a range as if it were selected (or clear it with null). Lets an app drop the native
	 * selection (and with it the OS selection toolbar on mobile) while its own menu is open.
	 */
	setPendingSelection(range: Range | null): void {
		const name = this.hlName('pending');
		if (range && this.HighlightCtor) {
			const h = new this.HighlightCtor(range);
			h.priority = 20;
			this.registry!.set(name, h);
		} else this.registry?.delete(name);
	}

	/** Highlights under a viewport point. */
	highlightsAt(x: number, y: number): HighlightSpec[] {
		const out: HighlightSpec[] = [];
		for (const h of this.highlights) {
			if (!h.range) continue;
			for (const r of Array.from(h.range.getClientRects())) {
				if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
					out.push(h.spec);
					break;
				}
			}
		}
		return out;
	}

	/** Temporarily emphasize the highlight(s) with the given ids (e.g. when hovering a backlink). */
	setHoveredHighlights(ids: string[]): void {
		const name = this.hlName('hover');
		const ranges = this.highlights.filter((h) => h.range && ids.includes(h.spec.id)).map((h) => h.range!);
		if (ranges.length) this.registry?.set(name, new this.HighlightCtor!(...ranges));
		else this.registry?.delete(name);
	}

	/** Range for a highlight spec (resolved). */
	highlightRange(id: string): Range | null {
		return this.highlights.find((h) => h.spec.id === id)?.range ?? null;
	}

	// ---------------------------------------------------------------------------------------------
	// Annotation layers
	// ---------------------------------------------------------------------------------------------

	/**
	 * Show a layer of annotations, e.g. ones another tool found in the book. Unlike highlights there
	 * may be thousands, so they are painted with static ranges and hit-tested by element. Calling it
	 * again with the same id replaces the layer.
	 */
	setLayer(id: string, specs: HighlightSpec[], opts: AnnotationLayerOptions = {}): void {
		const prev = this.layers.get(id);
		const layer: Layer = { key: prev?.key ?? ++this.layerCounter, opts, items: specs.map((spec) => ({ spec, range: null })), buckets: new Map(), resolved: false, names: prev?.names ?? [] };
		this.layers.set(id, layer);
		this.paintLayers();
	}

	removeLayer(id: string): void {
		const layer = this.layers.get(id);
		if (!layer) return;
		for (const name of layer.names) this.registry?.delete(name);
		this.layers.delete(id);
		this.paintLayers();
	}

	getLayer(id: string): HighlightSpec[] {
		return this.layers.get(id)?.items.map((i) => i.spec) ?? [];
	}

	/** A live range for an annotation of a layer (null when its locator doesn't resolve). */
	layerRange(layerId: string, specId: string): Range | null {
		const layer = this.layers.get(layerId);
		if (!layer) return null;
		this.resolveLayer(layer);
		const r = layer.items.find((i) => i.spec.id === specId)?.range;
		if (!r) return null;
		const range = this.doc.createRange();
		range.setStart(r.startContainer, r.startOffset);
		range.setEnd(r.endContainer, r.endOffset);
		return range;
	}

	/**
	 * A layer's annotations in book order, each with its text and chapter. Annotations whose locator
	 * doesn't resolve come last, with null text.
	 */
	describeLayer(id: string): { spec: HighlightSpec; text: string | null; tocItem: TocItem | null }[] {
		const layer = this.layers.get(id);
		if (!layer) return [];
		this.resolveLayer(layer);
		const a = this.doc.createRange();
		const b = this.doc.createRange();
		const set = (r: Range, s: StaticRange) => {
			r.setStart(s.startContainer, s.startOffset);
			r.setEnd(s.endContainer, s.endOffset);
		};
		const items = layer.items.filter((i) => i.range).sort((x, y) => {
			set(a, x.range!);
			set(b, y.range!);
			return a.compareBoundaryPoints(Range.START_TO_START, b) || a.compareBoundaryPoints(Range.END_TO_END, b);
		});
		const out: { spec: HighlightSpec; text: string | null; tocItem: TocItem | null }[] = items.map((i) => {
			set(a, i.range!);
			return { spec: i.spec, text: a.toString().replace(/\s+/g, ' ').trim(), tocItem: this.tocItemAt(i.range!) };
		});
		for (const i of layer.items) if (!i.range) out.push({ spec: i.spec, text: null, tocItem: null });
		a.detach();
		b.detach();
		return out;
	}

	private resolveLayer(layer: Layer): void {
		if (layer.resolved || !this.rendered) return;
		layer.resolved = true;
		const add = (el: Element | null, i: number) => {
			if (!el) return;
			const list = layer.buckets.get(el);
			if (list) {
				if (list[list.length - 1] !== i) list.push(i);
			} else layer.buckets.set(el, [i]);
		};
		const elementOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement);
		layer.items.forEach((item, i) => {
			const r = this.cachedRange(item.spec.locator);
			if (!r) return;
			item.range = new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset });
			add(elementOf(r.startContainer), i);
			add(elementOf(r.endContainer), i);
			add(elementOf(r.commonAncestorContainer), i);
		});
		// Live ranges slow down every DOM mutation; the static ones above are what layers keep.
		for (const item of layer.items) this.rangeCache.delete(item.spec.locator);
	}

	private paintLayers(): void {
		if (!this.rendered || !this.HighlightCtor) return;
		const pct = Math.round(this.highlightOpacity * 100);
		const rules: string[] = [];
		for (const layer of this.layers.values()) {
			this.resolveLayer(layer);
			for (const name of layer.names) this.registry!.delete(name);
			layer.names = [];
			if (layer.opts.hidden) continue;
			const groups = new Map<string, { css: string; ranges: StaticRange[] }>();
			for (const item of layer.items) {
				if (!item.range) continue;
				const { key, css } = this.colorKey(item.spec.color);
				let g = groups.get(key);
				if (!g) groups.set(key, (g = { css, ranges: [] }));
				g.ranges.push(item.range);
			}
			for (const [key, g] of groups) {
				const name = this.hlName(`layer${layer.key}-${key}`);
				const h = new this.HighlightCtor!(...g.ranges);
				h.priority = layer.opts.priority ?? -1;
				this.registry!.set(name, h);
				layer.names.push(name);
				const style = layer.opts.style?.(g.css) ?? `background-color: color-mix(in srgb, ${g.css} ${pct}%, transparent);`;
				rules.push(`::highlight(${name}) { ${style} }`);
			}
		}
		this.layerStyle.textContent = rules.join('\n');
	}

	/** Annotations of all layers under a viewport point. */
	layerHitsAt(x: number, y: number): LayerHit[] {
		if (!this.layers.size) return [];
		let el: Element | null = (this.shadow as unknown as DocumentOrShadowRoot).elementFromPoint?.(x, y) ?? null;
		if (!el || !this.content.contains(el)) return [];
		const chain: Element[] = [];
		for (; el && el !== this.content; el = el.parentElement) chain.push(el);
		const range = (this.hitRange ??= this.doc.createRange());
		const out: LayerHit[] = [];
		for (const [id, layer] of this.layers) {
			if (layer.opts.hidden) continue;
			this.resolveLayer(layer);
			const seen = new Set<number>();
			for (const e of chain) {
				for (const i of layer.buckets.get(e) ?? []) {
					if (seen.has(i)) continue;
					seen.add(i);
					const r = layer.items[i].range!;
					range.setStart(r.startContainer, r.startOffset);
					range.setEnd(r.endContainer, r.endOffset);
					if (rectsContain(range, x, y, 1)) out.push({ layer: id, spec: layer.items[i].spec });
				}
			}
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------------------------

	search(query: string, opts: SearchOptions = {}): SearchResult[] {
		if (!this.rendered) return [];
		const index = this.textIndex;
		return searchIndex(index, query, opts).map((m) => {
			let range: Range | null = null;
			let staticRange: StaticRange | null = null;
			const getRange = () => (range ??= index.toRange(m.start, m.end));
			const getStatic = () => (staticRange ??= index.toStaticRange(m.start, m.end));
			return {
				...m,
				range: getRange,
				staticRange: getStatic,
				cfi: () => this.cfiFromRange(getRange()) ?? '',
				tocItem: () => this.tocItemAt(getStatic()),
			};
		});
	}

	/** Paint search matches; `current` is emphasized and scrolled into view. */
	showSearchResults(results: SearchResult[], current = -1): void {
		if (!this.HighlightCtor) return;
		const all = this.hlName('search');
		const cur = this.hlName('search-current');
		if (!results.length) {
			this.registry!.delete(all);
			this.registry!.delete(cur);
			return;
		}
		// Static ranges: thousands of live Ranges would slow down every DOM mutation in the window.
		this.registry!.set(all, new this.HighlightCtor!(...results.map((r) => r.staticRange())));
		const c = results[current];
		if (c) {
			this.registry!.set(cur, new this.HighlightCtor!(c.staticRange()));
			this.scrollToRange(c.range(), { flash: false, position: 'center' });
		} else this.registry!.delete(cur);
	}

	// ---------------------------------------------------------------------------------------------
	// Events
	// ---------------------------------------------------------------------------------------------

	private bindEvents(): void {
		// Moving the host in the DOM (e.g. dragging a tab to another pane) or hiding it resets scrollTop,
		// and width changes reflow the text: restore the reading anchor in both cases.
		if (typeof ResizeObserver !== 'undefined') {
			const ro = new ResizeObserver(() => {
				const w = this.host.clientWidth;
				const h = this.host.clientHeight;
				const prev = this.hostSize;
				this.hostSize = { w, h };
				if (!w || !h || !this.rendered || !this.anchor) return;
				if (!prev.w || !prev.h || prev.w !== w) {
					this.win.clearTimeout(this.relocateTimer);
					this.scrollToRange(this.anchor, { position: this.anchorPosition });
				}
			});
			ro.observe(this.host);
			this.cleanup.push(() => ro.disconnect());
		}

		const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
			el.addEventListener(type, fn as EventListener, opts);
			this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
		};

		on(this.scroller, 'click', (e) => {
			const a = (e.target as Element | null)?.closest?.('a');
			if (a && this.content.contains(a)) {
				const internal = a.getAttribute('data-epp-href');
				const external = a.getAttribute('data-epp-external');
				if (internal || external) {
					e.preventDefault();
					if (internal && !this.onInternalLink?.(internal, e)) this.goTo(internal);
					else if (external) this.emit('external-link', e, external);
					return;
				}
			}
			const sel = this.getSelectionRange();
			if (sel) return;
			const hits = this.highlightsAt(e.clientX, e.clientY);
			if (hits.length) {
				this.emit('highlight-click', e, hits);
				return;
			}
			const annotations = this.layerHitsAt(e.clientX, e.clientY);
			if (annotations.length) this.emit('annotation-click', e, annotations);
		});

		on(this.scroller, 'contextmenu', (e) => {
			const range = this.getSelectionRange();
			let selection = range ? this.describeRange(range) : null;
			// Ignore a selection that isn't under the pointer.
			if (selection && !rectsContain(selection.range, e.clientX, e.clientY)) selection = null;
			this.emit('contextmenu', e, { selection, highlights: this.highlightsAt(e.clientX, e.clientY), annotations: this.layerHitsAt(e.clientX, e.clientY) });
		});

		let hoverRaf = 0;
		on(this.scroller, 'mouseleave', (e) => {
			if (this.lastHover) {
				this.lastHover = '';
				this.emit('highlight-hover', e, []);
			}
			if (this.lastLayerHover) {
				this.lastLayerHover = '';
				this.emit('annotation-hover', e, []);
			}
		});
		on(this.scroller, 'mousemove', (e) => {
			if (hoverRaf || (!this.highlights.length && !this.layers.size)) return;
			hoverRaf = this.win.requestAnimationFrame(() => {
				hoverRaf = 0;
				const hits = this.highlightsAt(e.clientX, e.clientY);
				const annotations = this.layerHitsAt(e.clientX, e.clientY);
				this.scroller.style.cursor = hits.length || annotations.length ? 'pointer' : '';
				const key = hits.map((h) => h.id).join('|');
				if (key !== this.lastHover) {
					this.lastHover = key;
					this.emit('highlight-hover', e, hits); // empty when leaving highlights
				}
				const layerKey = annotations.map((a) => `${a.layer}:${a.spec.id}`).join('|');
				if (layerKey !== this.lastLayerHover) {
					this.lastLayerHover = layerKey;
					this.emit('annotation-hover', e, annotations);
				}
			});
		});

		on(this.scroller, 'scroll', () => {
			this.win.clearTimeout(this.relocateTimer);
			this.relocateTimer = this.win.setTimeout(() => {
				// Skip while hidden, detached, or after moving to another window (the owner rebuilds us then).
				if (!this.host.isConnected || !this.host.clientHeight || this.host.ownerDocument !== this.doc) return;
				const a = this.currentAnchor();
				if (a) {
					this.anchor = a;
					this.anchorPosition = 'top';
				}
				const loc = this.getLocation();
				if (loc) this.emit('relocated', loc);
			}, 150);
		}, { passive: true });

		let selTimer = 0;
		on(this.doc, 'selectionchange' as any, () => {
			this.win.clearTimeout(selTimer);
			selTimer = this.win.setTimeout(() => {
				if (this.destroyed) return;
				const r = this.getSelectionRange();
				this.emit('selectionchange', r ? this.describeRange(r) : null);
			}, 250);
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.win.clearTimeout(this.relocateTimer);
		this.win.clearTimeout(this.flashTimer);
		this.win.cancelAnimationFrame(this.flashRaf);
		for (const fn of this.cleanup) fn();
		for (const name of this.highlightNames) this.registry?.delete(name);
		for (const layer of this.layers.values()) for (const name of layer.names) this.registry?.delete(name);
		for (const k of ['flash', 'search', 'search-current', 'hover', 'pending']) this.registry?.delete(this.hlName(k));
		this.fontStyle?.remove();
		this.shadow.replaceChildren();
		this.removeAllListeners();
	}
}

function yieldToBrowser(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

function rangeRect(range: Range): DOMRect | null {
	const rects = range.getClientRects();
	if (rects.length) return rects[0];
	// Collapsed points between blocks (e.g. inside whitespace-only text) have no box: use the nearest
	// rendered element after the point, else before it, else the container.
	const c = range.startContainer;
	const start: Node | null = c.nodeType === 3 ? c.nextSibling : (c.childNodes[range.startOffset] ?? null);
	for (let n = start; n; n = n.nextSibling) if (n.nodeType === 1) return (n as Element).getBoundingClientRect();
	const before: Node | null = c.nodeType === 3 ? c.previousSibling : (c.childNodes[range.startOffset - 1] ?? null);
	for (let n = before; n; n = n.previousSibling) if (n.nodeType === 1) {
		const r = (n as Element).getBoundingClientRect();
		return new DOMRect(r.left, r.bottom, r.width, 0);
	}
	const el = c.nodeType === 1 ? (c as Element) : c.parentElement;
	return el?.getBoundingClientRect() ?? null;
}

function rectsContain(range: Range, x: number, y: number, slack = 2): boolean {
	for (const r of Array.from(range.getClientRects())) if (x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack) return true;
	return false;
}

const BLOCK_RE = /^(p|div|h[1-6]|li|blockquote|section|article|header|footer|pre|tr|dd|dt|figure|figcaption|aside|table|ul|ol)$/;

/** Plain text of a range, with paragraph breaks preserved and whitespace collapsed within blocks. */
export function rangeText(range: Range): string {
	const root = range.commonAncestorContainer;
	const out: string[] = [];
	let lastBlock: Element | null = null;
	const blockOf = (n: Node) => {
		let e = n.parentElement;
		while (e && !BLOCK_RE.test(e.localName) && !e.classList.contains('epp-body')) e = e.parentElement;
		return e;
	};
	const pushText = (n: Text, s: string) => {
		const b = blockOf(n);
		if (lastBlock && b !== lastBlock) out.push('\n\n');
		lastBlock = b;
		out.push(s);
	};
	if (root.nodeType === 3) {
		pushText(root as Text, (root as Text).data.slice(range.startOffset, range.endOffset));
	} else {
		const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			if (!range.intersectsNode(n)) continue;
			if (n.parentElement?.closest('script,style')) continue;
			let s = n.data;
			if (n === range.endContainer) s = s.slice(0, range.endOffset);
			if (n === range.startContainer) s = s.slice(range.startOffset);
			pushText(n, s);
		}
	}
	return out
		.join('')
		.split('\n\n')
		.map((p) => p.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n\n');
}
