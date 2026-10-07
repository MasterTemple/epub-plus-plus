import { parseLocator, tryParseCfi } from '@epub-pp/core';
import { headingLabel, parseHeadings } from './annotation-utils';
import { getComment } from './comment-utils';
import { Events, TFile, parseLinktext, type App, type CachedMetadata, type Pos, type ReferenceCache } from 'obsidian';

export interface HighlightEntry {
	/** Stable within a session: `${sourcePath}:${offset}`. */
	id: string;
	epubPath: string;
	sourcePath: string;
	/** `epubcfi(...)` or `:~:text=...` */
	locator: string;
	color?: string;
	subpath: string;
	displayText: string;
	original: string;
	position: Pos;
	/** Comment written next to the link in the note (see comment-utils), once loaded. */
	comment?: string | null;
	/** Label of the nearest heading above the link in its note (e.g. the annotation-file section). */
	heading?: string | null;
}

/**
 * Index of every link from a markdown note into an EPUB that carries a CFI or text-fragment subpath.
 * Each such link is rendered as a highlight in the EPUB. Kept live through metadata cache events.
 */
export class HighlightIndex extends Events {
	/** epubPath → sourcePath → entries */
	private byEpub = new Map<string, Map<string, HighlightEntry[]>>();
	/** sourcePath → set of epub paths it links to */
	private bySource = new Map<string, Set<string>>();

	constructor(private app: App) {
		super();
	}

	override on(name: 'changed', cb: (epubPaths: Set<string>) => void): ReturnType<Events['on']> {
		return super.on(name, cb as (...data: unknown[]) => unknown);
	}

	get(epubPath: string): HighlightEntry[] {
		const m = this.byEpub.get(epubPath);
		return m ? [...m.values()].flat() : [];
	}

	rebuild(): void {
		const affected = new Set<string>(this.byEpub.keys());
		this.byEpub.clear();
		this.bySource.clear();
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const dests = resolved[file.path];
			if (dests && !Object.keys(dests).some((d) => d.toLowerCase().endsWith('.epub'))) continue;
			for (const p of this.indexFile(file, false)) affected.add(p);
		}
		this.trigger('changed', affected);
	}

	/** Re-index one note. Returns the affected EPUB paths. */
	indexFile(file: TFile, notify = true): Set<string> {
		const affected = this.removeSource(file.path);
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache) {
			for (const e of this.extract(file.path, cache)) {
				let m = this.byEpub.get(e.epubPath);
				if (!m) this.byEpub.set(e.epubPath, (m = new Map()));
				let list = m.get(file.path);
				if (!list) m.set(file.path, (list = []));
				list.push(e);
				let s = this.bySource.get(file.path);
				if (!s) this.bySource.set(file.path, (s = new Set()));
				s.add(e.epubPath);
				affected.add(e.epubPath);
			}
		}
		if (notify && affected.size) this.trigger('changed', affected);
		if (cache && this.bySource.has(file.path)) void this.loadComments(file);
		return affected;
	}

	/** Comments need the note's text (not in the metadata cache): read it and attach them. */
	private async loadComments(file: TFile): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const lines = text.split('\n');
		const headings = parseHeadings(lines);
		const affected = new Set<string>();
		for (const epub of this.bySource.get(file.path) ?? []) {
			for (const e of this.byEpub.get(epub)?.get(file.path) ?? []) {
				const comment = getComment(lines, e.position.start.line);
				let heading: string | null = null;
				for (const h of headings) if (h.line < e.position.start.line) heading = headingLabel(h.text);
				if (comment !== (e.comment ?? null) || heading !== (e.heading ?? null)) affected.add(epub);
				e.comment = comment;
				e.heading = heading;
			}
		}
		if (affected.size) this.trigger('changed', affected);
	}

	removeSource(sourcePath: string, notify = false): Set<string> {
		const affected = new Set(this.bySource.get(sourcePath) ?? []);
		for (const epub of affected) {
			const m = this.byEpub.get(epub);
			m?.delete(sourcePath);
			if (m && !m.size) this.byEpub.delete(epub);
		}
		this.bySource.delete(sourcePath);
		if (notify && affected.size) this.trigger('changed', affected);
		return affected;
	}

	private extract(sourcePath: string, cache: CachedMetadata): HighlightEntry[] {
		const out: HighlightEntry[] = [];
		const refs: ReferenceCache[] = [...(cache.links ?? []), ...(cache.embeds ?? [])];
		for (const ref of refs) {
			const entry = this.toEntry(sourcePath, ref);
			if (entry) out.push(entry);
		}
		return out;
	}

	private toEntry(sourcePath: string, ref: ReferenceCache): HighlightEntry | null {
		const { path, subpath } = parseLinktext(ref.link);
		if (!subpath) return null;
		const file = resolveEpub(this.app, path, sourcePath);
		if (!file) return null;
		const loc = parseLocator(subpath);
		const locator = loc.cfi ?? loc.textFragment;
		if (!locator) return null;
		// A point CFI is a position (e.g. annotation file headings), not a highlight.
		if (loc.cfi && !tryParseCfi(loc.cfi)?.range) return null;
		return {
			id: `${sourcePath}:${ref.position.start.offset}`,
			epubPath: file.path,
			sourcePath,
			locator,
			color: loc.params.color,
			subpath,
			displayText: ref.displayText ?? '',
			original: ref.original,
			position: ref.position,
		};
	}
}

/** Resolve a link path to an EPUB file (tolerates percent-encoded markdown link paths). */
export function resolveEpub(app: App, path: string, sourcePath: string): TFile | null {
	const tries = [path];
	try {
		const d = decodeURIComponent(path);
		if (d !== path) tries.push(d);
	} catch {
		/* ignore */
	}
	for (const p of tries) {
		const f = app.metadataCache.getFirstLinkpathDest(p, sourcePath);
		if (f && f.extension.toLowerCase() === 'epub') return f;
	}
	return null;
}
