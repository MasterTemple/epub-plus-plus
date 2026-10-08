/**
 * Apple Books highlights, from its annotation database (`AEAnnotation*.sqlite`, table ZAEANNOTATION),
 * converted to the JSON that file-plus-plus imports. Pure logic (unit-tested).
 *
 * Books are identified only by Apple's asset id (the titles live in another database), so the user maps
 * each asset to an EPUB in the vault once.
 */
import type { Row } from './sqlite';
import { SqliteReader } from './sqlite';

export interface AppleHighlight {
	assetId: string;
	cfi: string;
	text: string;
	note: string;
	/** A palette name. */
	color: string;
	/** Last modified (or created). */
	updated: Date | null;
	/** The chapter Apple Books shows for it, if any. */
	chapter: string | null;
}

/** One book (asset) of the database. */
export interface AppleAsset {
	id: string;
	highlights: AppleHighlight[];
	/** A few highlighted passages, to recognize the book by. */
	samples: string[];
	chapters: string[];
}

/** Apple Books' highlight styles → palette names (pink has no palette color of its own: red). */
export const APPLE_STYLE_COLORS: Record<number, string> = { 0: 'yellow', 1: 'green', 2: 'blue', 3: 'yellow', 4: 'red', 5: 'purple' };

/** Core Data timestamps count seconds from 2001-01-01. */
const CORE_DATA_EPOCH = 978307200;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);

/** The highlights among the database's annotation rows: type 2, not deleted, with a location and text. */
export function appleHighlights(rows: Iterable<Row>): AppleHighlight[] {
	const out: AppleHighlight[] = [];
	for (const r of rows) {
		if (num(r.ZANNOTATIONTYPE) !== 2 || num(r.ZANNOTATIONDELETED)) continue;
		const cfi = str(r.ZANNOTATIONLOCATION).trim();
		const text = str(r.ZANNOTATIONSELECTEDTEXT).trim();
		const assetId = str(r.ZANNOTATIONASSETID).trim();
		if (!cfi.startsWith('epubcfi(') || !text || !assetId) continue;
		const time = num(r.ZANNOTATIONMODIFICATIONDATE) ?? num(r.ZANNOTATIONCREATIONDATE);
		const chapter = str(r.ZFUTUREPROOFING5).trim();
		out.push({
			assetId,
			cfi,
			text,
			note: str(r.ZANNOTATIONNOTE).trim(),
			color: APPLE_STYLE_COLORS[num(r.ZANNOTATIONSTYLE) ?? 3] ?? 'yellow',
			updated: time === null ? null : new Date((time + CORE_DATA_EPOCH) * 1000),
			chapter: chapter || null,
		});
	}
	return out;
}

/** Read a database (and its write-ahead log, which holds the newest changes). */
export function readAppleBooks(db: Uint8Array, wal?: Uint8Array | null): AppleHighlight[] {
	const reader = new SqliteReader(db, wal);
	if (!reader.table('ZAEANNOTATION')) throw new Error('Not an Apple Books annotation database (no ZAEANNOTATION table)');
	return appleHighlights(reader.rows('ZAEANNOTATION'));
}

/** Highlights grouped by book, most highlighted first. */
export function groupByAsset(highlights: AppleHighlight[]): AppleAsset[] {
	const map = new Map<string, AppleHighlight[]>();
	for (const h of highlights) map.set(h.assetId, [...(map.get(h.assetId) ?? []), h]);
	return [...map]
		.map(([id, list]) => {
			const byLength = [...list].sort((a, b) => b.text.length - a.text.length);
			return {
				id,
				highlights: list,
				samples: byLength.slice(0, 3).map((h) => (h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text)),
				chapters: [...new Set(list.map((h) => h.chapter).filter((c): c is string => !!c && c !== 'Table of Contents'))].slice(0, 5),
			};
		})
		.sort((a, b) => b.highlights.length - a.highlights.length);
}

/**
 * The import JSON (file-plus-plus's format) for the highlights of mapped books (`books`: asset id →
 * vault path; unmapped or empty: left out). The selected text goes along, so passages are still found
 * when the vault's EPUB is a different edition than Apple's.
 */
export function toImportJson(highlights: AppleHighlight[], books: Record<string, string>): string {
	const items = highlights
		.filter((h) => books[h.assetId])
		.map((h) => ({
			book: books[h.assetId],
			cfi: h.cfi,
			text: h.text,
			...(h.note ? { comment: h.note } : {}),
			color: h.color,
			...(h.updated ? { updated: h.updated.toISOString() } : {}),
		}));
	return JSON.stringify(items, null, 1);
}
