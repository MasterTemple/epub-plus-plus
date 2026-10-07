import { flattenToc, type SelectionInfo } from '@epub-pp/core';
import { TFile, normalizePath, parseLinktext } from 'obsidian';
import { cfiKey, insertAnnotation, type Placement, type TextFragmentResolver } from './annotation-utils';
import { renderTemplate } from './link-utils';
import type EpubPlusPlus from './main';
import { ANNOTATION_EPUB_KEY, ANNOTATION_MODES, ANNOTATION_MODE_KEY, type AnnotationMode } from './settings';
import type { EpubView } from './view';

/**
 * Annotation files: one markdown file per book with a heading per TOC entry. New annotations from
 * the book can be inserted there at the right place instead of (or as well as) being copied.
 */
export class Annotations {
	constructor(private plugin: EpubPlusPlus) {}

	private get app() {
		return this.plugin.app;
	}

	/** The annotation file of an EPUB: a note whose `epub` property links to it. */
	find(epub: TFile): TFile | null {
		const { metadataCache, vault } = this.app;
		for (const f of vault.getMarkdownFiles()) {
			const links = metadataCache.getFileCache(f)?.frontmatterLinks;
			if (!links) continue;
			for (const l of links) {
				if (l.key !== ANNOTATION_EPUB_KEY) continue;
				const dest = metadataCache.getFirstLinkpathDest(parseLinktext(l.link).path, f.path);
				if (dest?.path === epub.path) return f;
			}
		}
		return null;
	}

	/** The file's own mode (frontmatter) or the global default. */
	mode(file: TFile): AnnotationMode {
		const v = this.app.metadataCache.getFileCache(file)?.frontmatter?.[ANNOTATION_MODE_KEY];
		return ANNOTATION_MODES.includes(v) ? v : this.plugin.settings.annotationMode;
	}

	async setMode(file: TFile, mode: AnnotationMode): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[ANNOTATION_MODE_KEY] = mode;
		});
	}

	/** Create the annotation file for the book open in `view` (or return the existing one). */
	async create(view: EpubView): Promise<TFile> {
		const epub = view.file!;
		const existing = this.find(epub);
		if (existing) return existing;
		const { reader, book } = view;
		if (!reader || !book) throw new Error('The book is not loaded yet');
		const s = this.plugin.settings;
		const { vault } = this.app;

		const folder = normalizePath(s.annotationFolder.trim() || epub.parent?.path || '/');
		const vars = { book: book.metadata.title, author: book.metadata.creators.join(', '), file: epub.basename };
		const name = sanitizeFileName(renderTemplate(s.annotationFileName, vars)) || `${epub.basename} - Annotations`;
		let path = normalizePath(`${folder}/${name}.md`);
		for (let n = 2; vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${name} ${n}.md`);
		if (folder !== '/' && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);

		const epubLinktext = this.app.metadataCache.fileToLinktext(epub, path, false).replace(/"/g, '\\"');
		const lines = ['---', `${ANNOTATION_EPUB_KEY}: "[[${epubLinktext}]]"`, '---', ''];
		for (const item of flattenToc(book.toc)) {
			const label = item.label || 'Untitled';
			let heading = label;
			if (item.href) {
				const range = reader.resolve(item.href);
				range?.collapse(true);
				// A point CFI: the heading links to the chapter without drawing a highlight.
				const cfi = range && reader.cfiFromRange(range);
				if (cfi) heading = this.plugin.epubLink(epub, cfi, label, null, path);
			}
			lines.push(`${'#'.repeat(Math.min(6, item.depth + 1))} ${heading}`, '');
		}
		return vault.create(path, lines.join('\n'));
	}

	/** Insert a rendered annotation at its place in the annotation file. */
	async insert(view: EpubView, file: TFile, info: SelectionInfo, block: string): Promise<Placement> {
		const sel = cfiKey(info.cfi);
		if (!sel) throw new Error('Selection has no CFI');
		const reader = view.reader;
		const resolve: TextFragmentResolver =
			this.plugin.settings.annotationResolveTextFragments && reader
				? (tf) => {
						const range = reader.resolve(tf);
						return cfiKey((range && reader.cfiFromRange(range)) ?? undefined);
					}
				: () => null;
		let placement: Placement | null = null;
		await this.app.vault.process(file, (data) => {
			const res = insertAnnotation(data, sel, block, resolve);
			placement = res.placement;
			return res.data;
		});
		return placement!;
	}
}

function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
