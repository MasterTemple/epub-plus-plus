/**
 * EPUB locators (link subpaths), on top of file-plus-plus's locator schemes:
 *
 *   `#epubcfi(/6/4!/4/2,/1:0,/1:12)&color=yellow`   a CFI (range: a highlight; point: a position)
 *   `#:~:text=call%20me-,Ishmael&color=red`         a text fragment (shared with every format)
 *   `#chapter_001.xhtml#c001p0003`                   an href into the book (a position)
 *
 * Parameters after the locator are `&key=value` pairs (PDF++ style). The input may have been
 * percent-decoded once already (Obsidian decodes markdown link targets), or not at all.
 */
import { parseLocator, safeDecode, textFragmentScheme, type LocatorScheme } from 'file-plus-plus/core';
import { tryParseCfi } from './cfi';

export const cfiScheme: LocatorScheme = {
	id: 'cfi',
	match(input) {
		if (!/^epubcfi(\(|%28)/i.test(input)) return null;
		const s = /^epubcfi%28/i.test(input) ? safeDecode(input) : input;
		// Find the matching close paren, honoring ^-escapes.
		let depth = 0;
		let end = -1;
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (c === '^') {
				i++;
				continue;
			}
			if (c === '(') depth++;
			else if (c === ')' && --depth === 0) {
				end = i;
				break;
			}
		}
		if (end === -1) end = s.length - 1;
		let cfi = s.slice(0, end + 1);
		if (cfi.includes('%')) cfi = safeDecode(cfi);
		return { locator: cfi, rest: s.slice(end + 1) };
	},
	isRange: (locator) => !!tryParseCfi(locator)?.range,
};

/** A path into the book (may itself contain a `#fragment`); anything that isn't `key=value`. */
export const hrefScheme: LocatorScheme = {
	id: 'href',
	match(s) {
		if (!s || /^[\w-]+=/.test(s)) return null;
		const amp = s.search(/&[\w-]+=/);
		return amp === -1 ? { locator: s, rest: '' } : { locator: s.slice(0, amp), rest: s.slice(amp) };
	},
};

export const EPUB_SCHEMES: LocatorScheme[] = [cfiScheme, textFragmentScheme, hrefScheme];

export interface ParsedEpubLocator {
	cfi?: string;
	/** The full directive, `:~:text=...` */
	textFragment?: string;
	href?: string;
	params: Record<string, string>;
}

/** Parse a subpath into its CFI, text fragment or href, and params. */
export function parseEpubLocator(input: string): ParsedEpubLocator {
	const loc = parseLocator(input, EPUB_SCHEMES);
	const out: ParsedEpubLocator = { params: loc.params };
	if (loc.scheme === 'cfi') out.cfi = loc.locator!;
	else if (loc.scheme === 'text') out.textFragment = loc.locator!;
	else if (loc.scheme === 'href') out.href = loc.locator!;
	return out;
}

/** True when a subpath looks like an EPUB locator we highlight or jump to (CFI or text fragment). */
export function isEpubLocator(subpath: string): boolean {
	const l = parseEpubLocator(subpath);
	return !!(l.cfi || l.textFragment);
}
