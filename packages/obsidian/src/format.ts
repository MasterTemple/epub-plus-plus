import { EpubBook, EpubReader, EPUB_SCHEMES, cfiEnd, cfiStart, comparePaths, splitIndirection, tryParseCfi, type CfiPath } from '@epub-pp/core';
import type { ParsedLocator } from 'file-plus-plus/core';
import type { FileFormat } from 'file-plus-plus/obsidian';

/** EPUB for file-plus-plus: books, CFI links, the publisher's styles. */
export const epubFormat: FileFormat<EpubBook, EpubReader> = {
	name: 'EPUB',
	noun: 'book',
	extensions: ['epub'],
	icon: 'book-open',
	frontmatterKey: 'epub',
	schemes: EPUB_SCHEMES,
	linkTypeName: 'CFI',
	linkTypeDescription: 'EPUB CFI links are exact. Text fragment links are human-readable and survive edits to the EPUB file.',
	position: {
		key: (locator: string): CfiPath | null => {
			const cfi = tryParseCfi(locator);
			return cfi ? cfiStart(cfi) : null;
		},
		compare: comparePaths,
	},
	load: async (app, file) => EpubBook.open(await app.vault.readBinary(file)),
	unload: (book) => book.destroy(),
	info: (book) => ({ title: book.metadata.title, author: book.metadata.creators.join(', ') }),
	createReader: (host, book, opts, preview) => new EpubReader(host, book, { ...opts, spineItems: preview ? spineItemsFor(book, preview) : undefined }),
	templateVars: (info) => ({ cfi: info.locator }),
	extraTemplateVars: '{{book}}, {{cfi}}',
};

/** Spine items worth rendering for a preview: just the target's (fast), or everything for text fragments. */
function spineItemsFor(book: EpubBook, loc: ParsedLocator): number[] | undefined {
	if (loc.scheme === 'cfi') {
		const cfi = tryParseCfi(loc.locator!);
		if (!cfi) return undefined;
		const a = book.spineItemForCfiSteps(splitIndirection(cfiStart(cfi).steps).outer)?.index;
		const b = book.spineItemForCfiSteps(splitIndirection(cfiEnd(cfi).steps).outer)?.index ?? a;
		if (a === undefined || b === undefined) return undefined;
		return range(Math.min(a, b), Math.max(a, b));
	}
	if (loc.scheme === 'href') {
		const href = loc.locator!;
		const item = book.spineItemForHref(href) ?? book.spine.find((s) => s.href.endsWith(`/${href.split('#')[0]}`));
		return item ? [item.index] : undefined;
	}
	if (loc.scheme === 'text') return undefined;
	return range(0, Math.min(2, book.spine.length - 1));
}

function range(a: number, b: number): number[] {
	return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
