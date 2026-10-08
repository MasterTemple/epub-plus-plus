import type { CfiOptions, ExtractOptions, TextSection } from '@epub-pp/core';
import type { Annotation, AnnotationProvider, FileApi } from 'file-plus-plus/obsidian';
import type { TFile } from 'obsidian';

/**
 * The API other plugins use: `app.plugins.plugins['epub-plus-plus']?.api`, available once the
 * workspace event `epub-plus-plus:api-ready` (argument: the API) has fired. `epub-plus-plus:api-unload`
 * fires when EPUB++ unloads; providers registered before then are gone and must be registered again
 * on the next `api-ready`.
 *
 * The pattern: extract a book's text, find things in it, turn the offsets into CFIs, and register an
 * annotation provider that hands them back. EPUB++ draws them, lists them in a sidebar tab, and lets
 * the user save one as a real highlight (a link in the book's annotation file).
 *
 * Everything but `extractText` is file-plus-plus's `FileApi`, shared with the other ++ plugins.
 */
export interface EpubPlusPlusApi extends FileApi {
	/** A book's text, one section per spine item, without opening it in a view. */
	extractText(file: TFile, opts?: ExtractOptions): Promise<ExtractedBook>;
}

export interface ExtractedBook {
	/** `title`: the first table-of-contents entry pointing into the section. */
	sections: (TextSection & { title: string | null })[];
	/** A range CFI for UTF-16 offsets `[start, end)` in a section's text. */
	cfi(spineIndex: number, start: number, end: number, opts?: CfiOptions): string | null;
}

export type EpubAnnotation<T = unknown> = Annotation<T>;
export type { AnnotationContext } from 'file-plus-plus/obsidian';
export type { AnnotationProvider };

export const API_READY_EVENT = 'epub-plus-plus:api-ready';
export const API_UNLOAD_EVENT = 'epub-plus-plus:api-unload';
