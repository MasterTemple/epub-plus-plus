import type { CfiOptions, ExtractOptions, TextSection } from '@epub-pp/core';
import type { Menu, TFile } from 'obsidian';

/**
 * The API other plugins use: `app.plugins.plugins['epub-plus-plus']?.api`, available once the
 * workspace event `epub-plus-plus:api-ready` (argument: the API) has fired. `epub-plus-plus:api-unload`
 * fires when EPUB++ unloads; providers registered before then are gone and must be registered again
 * on the next `api-ready`.
 *
 * The pattern: extract a book's text, find things in it, turn the offsets into CFIs, and register an
 * annotation provider that hands them back. EPUB++ draws them, lists them in a sidebar tab, and lets
 * the user save one as a real highlight (a link in the book's annotation file).
 */
export interface EpubPlusPlusApi {
	/** Bumped on breaking changes. */
	readonly version: 1;
	/** A book's text, one section per spine item, without opening it in a view. */
	extractText(file: TFile, opts?: ExtractOptions): Promise<ExtractedBook>;
	/** Returns a function that unregisters the provider. */
	registerAnnotationProvider<T>(provider: AnnotationProvider<T>): () => void;
	/** Ask EPUB++ to fetch a provider's annotations again (for some EPUB paths, or all open books). */
	refreshAnnotations(providerId: string, paths?: string[]): void;
	/** Open an EPUB (reusing its tab) and jump to a locator. */
	open(file: TFile, locator?: string): Promise<void>;
	/** A wiki or markdown link to a locator, in the user's link style. */
	link(file: TFile, locator: string, alias: string, sourcePath?: string): string;
}

export interface ExtractedBook {
	/** `title`: the first table-of-contents entry pointing into the section. */
	sections: (TextSection & { title: string | null })[];
	/** A range CFI for UTF-16 offsets `[start, end)` in a section's text. */
	cfi(spineIndex: number, start: number, end: number, opts?: CfiOptions): string | null;
}

export interface EpubAnnotation<T = unknown> {
	/** Unique within the provider and book. */
	id: string;
	/** A range: `epubcfi(...)` or `:~:text=...`. */
	locator: string;
	/** Shown in the sidebar, menus and tooltips, e.g. "John 3:16". */
	label: string;
	/** A palette name or CSS color; default: the provider's `color`. */
	color?: string;
	data?: T;
}

/** What EPUB++ knows about an annotation when calling back into its provider. */
export interface AnnotationContext {
	file: TFile;
	/** The annotated text in the book. */
	text: string;
	/** The table-of-contents entry it's in. */
	chapter: string | null;
}

export interface AnnotationProvider<T = unknown> {
	/** Stable id; it also keys the user's show/hide choice. */
	id: string;
	/** Sidebar tab and menu label, e.g. "Bible references". */
	name: string;
	/** Lucide icon name for the sidebar tab. */
	icon?: string;
	/** Default color for annotations without one (palette name or CSS color). */
	color?: string;
	/**
	 * How annotations are drawn: CSS declarations for `::highlight()` given the resolved color, e.g.
	 * `` c => `text-decoration: underline dashed 2px ${c};` ``. Default: a background like highlights.
	 */
	style?: (color: string) => string;
	/** The annotations of a book. Called when a view opens it and on `refreshAnnotations`. */
	annotations(file: TFile): EpubAnnotation<T>[] | Promise<EpubAnnotation<T>[]>;
	/**
	 * A click (desktop) or tap (mobile) on annotations that isn't on a highlight. Return true when
	 * handled; otherwise desktop does nothing and mobile opens the menu.
	 */
	onClick?(annotations: EpubAnnotation<T>[], event: MouseEvent, ctx: AnnotationContext): boolean | void;
	/** Add items to the menu shown for these annotations (right-click, or a hold on mobile). */
	menu?(menu: Menu, annotations: EpubAnnotation<T>[], ctx: AnnotationContext): void;
	/** Hover text on desktop (default: the label). Return null for none. */
	tooltip?(annotation: EpubAnnotation<T>, ctx: AnnotationContext): string | null;
}

export const API_READY_EVENT = 'epub-plus-plus:api-ready';
export const API_UNLOAD_EVENT = 'epub-plus-plus:api-unload';
