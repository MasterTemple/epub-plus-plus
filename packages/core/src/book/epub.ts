import { unzipSync } from 'fflate';
import { elementSteps, type CfiStep } from '../locators/cfi';
import { resolvePath, splitFragment } from '../util/path';
import { flattenToc, parseNav, parseNcx, type TocItem } from './toc';
import { child, children, decodeText, descendants, parseContentDocument, parseXml, textOf } from './xml';

export interface ManifestItem {
	id: string;
	/** Zip-relative path. */
	href: string;
	mediaType: string;
	properties: string[];
}

export interface SpineItem {
	index: number;
	idref: string;
	href: string;
	mediaType: string;
	linear: boolean;
	properties: string[];
	/** CFI steps inside the package document leading to this itemref, e.g. `/6/4[idref]`. */
	cfiSteps: CfiStep[];
}

export interface BookMetadata {
	title: string;
	creators: string[];
	language: string;
	identifier: string;
	publisher: string;
	description: string;
	date: string;
	layout: 'reflowable' | 'pre-paginated';
}

const MIME_BY_EXT: Record<string, string> = {
	xhtml: 'application/xhtml+xml',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	ttf: 'font/ttf',
	otf: 'font/otf',
	woff: 'font/woff',
	woff2: 'font/woff2',
	mp3: 'audio/mpeg',
	mp4: 'video/mp4',
};

/**
 * A parsed EPUB container. Pure data access: no rendering, no DOM mutation outside parsed documents.
 * Works in any environment that provides `DOMParser`, `Blob` and `URL.createObjectURL`.
 */
export class EpubBook {
	readonly metadata: BookMetadata;
	readonly manifest = new Map<string, ManifestItem>();
	readonly spine: SpineItem[] = [];
	readonly toc: TocItem[];
	readonly opfPath: string;
	readonly coverHref: string | null;

	private readonly files: Record<string, Uint8Array>;
	private readonly byHref = new Map<string, ManifestItem>();
	private readonly spineByHref = new Map<string, SpineItem>();
	private readonly blobUrls = new Map<string, string>();

	static async open(data: ArrayBuffer | Uint8Array): Promise<EpubBook> {
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		return new EpubBook(unzipSync(bytes));
	}

	private constructor(files: Record<string, Uint8Array>) {
		this.files = files;
		const container = parseXml(this.text('META-INF/container.xml'));
		const rootfile = descendants(container, 'rootfile')[0]?.getAttribute('full-path');
		if (!rootfile) throw new Error('EPUB has no rootfile in META-INF/container.xml');
		this.opfPath = rootfile;

		const opf = parseXml(this.text(rootfile));
		const pkg = opf.documentElement;

		for (const item of descendants(child(pkg, 'manifest') ?? pkg, 'item')) {
			const href = resolvePath(rootfile, item.getAttribute('href') ?? '');
			const mi: ManifestItem = {
				id: item.getAttribute('id') ?? href,
				href,
				mediaType: item.getAttribute('media-type') ?? this.guessMime(href),
				properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
			};
			this.manifest.set(mi.id, mi);
			this.byHref.set(href, mi);
		}

		const spineEl = child(pkg, 'spine');
		for (const ref of spineEl ? children(spineEl, 'itemref') : []) {
			const idref = ref.getAttribute('idref') ?? '';
			const mi = this.manifest.get(idref);
			if (!mi) continue;
			const steps = elementSteps(pkg, ref);
			steps[steps.length - 1].id = ref.getAttribute('id') ?? idref;
			const si: SpineItem = {
				index: this.spine.length,
				idref,
				href: mi.href,
				mediaType: mi.mediaType,
				linear: ref.getAttribute('linear') !== 'no',
				properties: (ref.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
				cfiSteps: steps,
			};
			this.spine.push(si);
			this.spineByHref.set(si.href, si);
		}

		this.metadata = this.parseMetadata(child(pkg, 'metadata'));
		this.toc = this.parseToc(spineEl);
		this.coverHref = this.findCover(pkg);
	}

	private guessMime(path: string): string {
		return MIME_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
	}

	private parseMetadata(md: Element | null): BookMetadata {
		const dc = (name: string) => (md ? descendants(md, name) : []);
		const layout = md
			? descendants(md, 'meta').find((m) => m.getAttribute('property') === 'rendition:layout')
			: undefined;
		return {
			title: textOf(dc('title')[0]) || 'Untitled',
			creators: dc('creator').map((e) => textOf(e)).filter(Boolean),
			language: textOf(dc('language')[0]),
			identifier: textOf(dc('identifier')[0]),
			publisher: textOf(dc('publisher')[0]),
			description: textOf(dc('description')[0]),
			date: textOf(dc('date')[0]),
			layout: textOf(layout) === 'pre-paginated' ? 'pre-paginated' : 'reflowable',
		};
	}

	private parseToc(spineEl: Element | null): TocItem[] {
		const nav = [...this.manifest.values()].find((m) => m.properties.includes('nav'));
		if (nav && this.has(nav.href)) {
			const items = parseNav(parseContentDocument(this.text(nav.href), nav.mediaType), nav.href);
			if (items.length) return items;
		}
		const ncxId = spineEl?.getAttribute('toc');
		const ncx =
			(ncxId && this.manifest.get(ncxId)) ||
			[...this.manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');
		if (ncx && this.has(ncx.href)) return parseNcx(parseXml(this.text(ncx.href)), ncx.href);
		return [];
	}

	private findCover(pkg: Element): string | null {
		const byProp = [...this.manifest.values()].find((m) => m.properties.includes('cover-image'));
		if (byProp) return byProp.href;
		const meta = descendants(pkg, 'meta').find((m) => m.getAttribute('name') === 'cover');
		const id = meta?.getAttribute('content');
		return (id && this.manifest.get(id)?.href) || null;
	}

	// --- resource access -----------------------------------------------------

	has(path: string): boolean {
		return path in this.files;
	}

	bytes(path: string): Uint8Array {
		const f = this.files[path] ?? this.files[decodeURI(path)];
		if (!f) throw new Error(`EPUB resource not found: ${path}`);
		return f;
	}

	text(path: string): string {
		return decodeText(this.bytes(path));
	}

	mediaType(path: string): string {
		return this.byHref.get(path)?.mediaType ?? this.guessMime(path);
	}

	/** Object URL for a resource; cached and revoked by `destroy()`. */
	blobUrl(path: string): string | null {
		let url = this.blobUrls.get(path);
		if (url) return url;
		if (!this.has(path)) return null;
		url = URL.createObjectURL(new Blob([this.bytes(path) as BlobPart], { type: this.mediaType(path) }));
		this.blobUrls.set(path, url);
		return url;
	}

	/** Parse a spine item's content document. */
	loadDocument(item: SpineItem): Document {
		return parseContentDocument(this.text(item.href), item.mediaType);
	}

	spineItemForHref(href: string): SpineItem | undefined {
		return this.spineByHref.get(splitFragment(href).path);
	}

	/** Find a spine item from the outer (package document) part of a CFI. */
	spineItemForCfiSteps(steps: CfiStep[]): SpineItem | undefined {
		const last = steps[steps.length - 1];
		if (!last) return undefined;
		if (last.id) {
			const byId = this.spine.find((s) => s.cfiSteps[s.cfiSteps.length - 1].id === last.id || s.idref === last.id);
			if (byId) return byId;
		}
		return this.spine.find(
			(s) => s.cfiSteps.length === steps.length && s.cfiSteps[s.cfiSteps.length - 1].index === last.index,
		);
	}

	get flatToc(): TocItem[] {
		return flattenToc(this.toc);
	}

	destroy(): void {
		for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
		this.blobUrls.clear();
	}
}
