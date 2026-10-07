import { foldString, type TextIndex } from './text-index';

export interface SearchOptions {
	caseSensitive?: boolean;
	wholeWord?: boolean;
	regex?: boolean;
	/** Maximum number of results (default 1000). */
	limit?: number;
	/** Characters of context on each side of the match (default 40). */
	context?: number;
}

export interface SearchMatch {
	/** Range in TextIndex `text` coordinates. */
	start: number;
	end: number;
	spineIndex: number;
	excerpt: { before: string; match: string; after: string };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchIndex(index: TextIndex, query: string, opts: SearchOptions = {}): SearchMatch[] {
	if (!query.trim()) return [];
	const limit = opts.limit ?? 1000;
	const ctx = opts.context ?? 40;
	const haystack = opts.caseSensitive ? index.text : index.folded;
	let source: string;
	if (opts.regex) source = query;
	else {
		const q = opts.caseSensitive ? query.replace(/\s+/g, ' ').trim() : foldString(query);
		source = escapeRe(q);
	}
	if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
	let re: RegExp;
	try {
		re = new RegExp(source, opts.regex && !opts.caseSensitive ? 'giu' : 'gu');
	} catch {
		return [];
	}
	const out: SearchMatch[] = [];
	const T = index.text;
	for (const m of haystack.matchAll(re)) {
		if (!m[0].length) continue;
		let [start, end] = opts.caseSensitive ? [m.index!, m.index! + m[0].length] : index.foldedToText(m.index!, m.index! + m[0].length);
		out.push({
			start,
			end,
			spineIndex: index.spineIndexAt(start),
			excerpt: {
				before: (start > ctx ? '…' : '') + T.slice(Math.max(0, start - ctx), start).trimStart(),
				match: T.slice(start, end),
				after: T.slice(end, end + ctx).trimEnd() + (end + ctx < T.length ? '…' : ''),
			},
		});
		if (out.length >= limit) break;
	}
	return out;
}
