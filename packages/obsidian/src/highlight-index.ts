import { parseLocator } from '@epub-pp/core';
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
		return affected;
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
