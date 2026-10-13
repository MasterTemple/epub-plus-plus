import { expect, test } from 'bun:test';
import { parseImport } from 'file-plus-plus/notes';
import { appleHighlights, assetProbes, groupByAsset, htmlText, looseText, matchScore, toImportJson } from '../src/apple-books/apple-books';

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

test('matching a book by its highlights in an EPUB\'s text', () => {
	const texts = ['Watch and pray, lest you enter into temptation.', 'All believers, regardless of their station and season in life, need to be watchful.', 'Short'];
	const [asset] = groupByAsset(appleHighlights(texts.map((t, i) => row({ ZANNOTATIONSELECTEDTEXT: t, ZANNOTATIONLOCATION: `epubcfi(/6/2!/4/${i * 2 + 2}/1,:0,:5)` })) as never));
	const probes = assetProbes(asset!);
	expect(probes).toHaveLength(2); // "Short" is too short to tell books apart
	const html = '<html><head><title>x</title><style>p{}</style></head><body><p>“Watch and <em>pray</em>, lest you enter into temp&shy;tation.”</p><p>All believers, regardless of their station and season&#160;in life, need to be watch-ful.</p></body></html>';
	expect(htmlText(html)).not.toContain('<');
	expect(matchScore(probes, looseText(htmlText(html)))).toBe(1);
	expect(matchScore(probes, looseText('Watch and pray, lest you enter into temptation.'))).toBe(0.5);
	expect(matchScore([], 'anything')).toBe(0);
});
