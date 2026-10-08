import { expect, test } from 'bun:test';
import { parseImport } from 'file-plus-plus/notes';
import { appleHighlights, groupByAsset, toImportJson } from '../src/apple-books/apple-books';

const row = (o: Record<string, unknown>) => ({
	ZANNOTATIONTYPE: 2,
	ZANNOTATIONDELETED: 0,
	ZANNOTATIONASSETID: 'A1',
	ZANNOTATIONLOCATION: 'epubcfi(/6/16[x08]!/4/2/14/1,:0,:29)',
	ZANNOTATIONSELECTEDTEXT: 'Above all, I am thankful to God',
	ZANNOTATIONNOTE: null,
	ZANNOTATIONSTYLE: 3,
	ZANNOTATIONMODIFICATIONDATE: 800396462.5,
	ZANNOTATIONCREATIONDATE: 800396425.7,
	ZFUTUREPROOFING5: 'Preface',
	...o,
});

test('highlights: only live type-2 rows with a location and text', () => {
	const rows = [
		row({ ZANNOTATIONNOTE: ' A note ', ZANNOTATIONSTYLE: 4 }),
		row({ ZANNOTATIONDELETED: 1 }),
		row({ ZANNOTATIONTYPE: 1 }),
		row({ ZANNOTATIONSELECTEDTEXT: '' }),
		row({ ZANNOTATIONLOCATION: null }),
		row({ ZANNOTATIONASSETID: 'B2', ZANNOTATIONSTYLE: 1, ZANNOTATIONMODIFICATIONDATE: null }),
	];
	const hs = appleHighlights(rows as never);
	expect(hs.map((h) => [h.assetId, h.note, h.color, h.chapter])).toEqual([
		['A1', 'A note', 'red', 'Preface'],
		['B2', '', 'green', 'Preface'],
	]);
	expect(hs[0].updated?.toISOString()).toBe('2026-05-13T20:21:02.500Z');
	expect(hs[1].updated?.toISOString()).toBe('2026-05-13T20:20:25.700Z');
});

test('grouping and conversion to the import JSON', () => {
	const hs = appleHighlights([row({}), row({ ZANNOTATIONNOTE: 'n' }), row({ ZANNOTATIONASSETID: 'B2' })] as never);
	expect(groupByAsset(hs).map((a) => [a.id, a.highlights.length, a.chapters])).toEqual([
		['A1', 2, ['Preface']],
		['B2', 1, ['Preface']],
	]);
	const json = toImportJson(hs, { A1: 'Library/Books/Union.epub', B2: '' });
	const { entries, errors } = parseImport(json);
	expect(errors).toEqual([]);
	expect(entries.map((e) => [e.book, e.locator, e.text, e.comment, e.color])).toEqual([
		['Library/Books/Union.epub', 'epubcfi(/6/16[x08]!/4/2/14/1,:0,:29)', 'Above all, I am thankful to God', '', 'yellow'],
		['Library/Books/Union.epub', 'epubcfi(/6/16[x08]!/4/2/14/1,:0,:29)', 'Above all, I am thankful to God', 'n', 'yellow'],
	]);
	expect(entries[0].updated?.toISOString()).toBe('2026-05-13T20:21:02.500Z');
});
